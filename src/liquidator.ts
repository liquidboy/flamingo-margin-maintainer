/* eslint-disable no-plusplus */
/* eslint-disable no-constant-condition */
/* eslint-disable max-len */
/* eslint-disable no-await-in-loop */
import { tx, wallet } from '@cityofzion/neon-core';
import { RawData } from 'ws';
import { config } from './config';
import { logger } from './utils/loggingUtils';

import { AccountVaultBalance, DapiUtils } from './utils/dapiUtils';
import { NeoNotification, NeoNotificationInit } from './utils/notificationUtils';
import { WebhookUtils } from './utils/webhookUtils';

const properties = config.getProperties();

const PRIVATE_KEY: string = properties.privateKey;
const OWNER: wallet.Account = new wallet.Account(PRIVATE_KEY);
const DRY_RUN: boolean = properties.dryRun;
const FTOKEN_SCRIPT_HASH = properties.fTokenScriptHash;
const COLLATERAL_SCRIPT_HASH = properties.collateralScriptHash;
const ON_CHAIN_PRICE_ONLY = properties.onChainPriceOnly;
const ON_CHAIN_PRICE_DECIMALS = 20;
const LIQUIDATOR_NAME = properties.liquidatorName;
const LIQUIDATE_THRESHOLD = properties.liquidateThreshold;
const LOW_BALANCE_THRESHOLD = properties.lowBalanceThreshold;
const MAX_PAGE_SIZE = properties.maxPageSize;
const AUTO_SWAP = properties.autoSwap;
const SWAP_THRESHOLD = properties.swapThreshold;
const VERIFY_WAIT_MILLIS = properties.verifyWaitMillis;
const SLEEP_MILLIS = properties.sleepMillis;

// Globals, set on init
let FTOKEN_SYMBOL: string;
let COLLATERAL_SYMBOL: string;
let FTOKEN_MULTIPLIER: number;
let COLLATERAL_MULTIPLIER: number;
let FLM_SYMBOL: string;
let FLM_MULTIPLIER: number;
let FLUND_SYMBOL: string;
let FLUND_MULTIPLIER: number;
let MAX_LOAN_TO_VALUE: number;
let LIQUIDATION_LIMIT: number;
let LIQUIDATION_BONUS: number;

interface PriceData {
  payload: string;
  signature: string;
  decimals: number;
  fTokenPrice: number;
  collateralOnChainPrice: number;
  collateralOffChainPrice: number;
  collateralCombinedPrice: number;
}

async function submitTransaction(
  transaction: tx.Transaction,
  description: string,
) {
  await DapiUtils.checkNetworkFee(transaction);
  await DapiUtils.checkSystemFee(transaction);
  if (DRY_RUN) {
    logger.info(`Not submitting ${description} transaction since dry run...`);
    return null;
  }
  logger.info(`Submitting ${description} transaction...`);
  return DapiUtils.performTransfer(transaction, OWNER);
}

async function getPrices(
  fTokenHash: string,
  collateralHash: string,
  collateralSymbol: string,
  onChainPriceOnly: boolean,
) {
  if (onChainPriceOnly) {
    const fTokenOnChainPrice = +(await DapiUtils.getOnChainPrice(fTokenHash, ON_CHAIN_PRICE_DECIMALS));
    const collateralOnChainPrice = +(await DapiUtils.getOnChainPrice(collateralHash, ON_CHAIN_PRICE_DECIMALS));
    return {
      payload: '',
      signature: '',
      decimals: ON_CHAIN_PRICE_DECIMALS,
      fTokenPrice: fTokenOnChainPrice,
      collateralOnChainPrice,
      collateralOffChainPrice: collateralOnChainPrice,
      collateralCombinedPrice: collateralOnChainPrice,
    } as PriceData;
  }

  const priceData = await DapiUtils.getPriceFeed();
  const { decimals } = priceData.data;
  const fTokenOnChainPrice = +(await DapiUtils.getOnChainPrice(fTokenHash, decimals));
  const collateralOnChainPrice = +(await DapiUtils.getOnChainPrice(collateralHash, decimals));
  const collateralOffChainPrice = +priceData.data.prices[collateralSymbol];

  return {
    payload: priceData.payload,
    signature: priceData.signature,
    decimals: priceData.data.decimals,
    fTokenPrice: fTokenOnChainPrice,
    collateralOnChainPrice,
    collateralOffChainPrice,
    collateralCombinedPrice: (collateralOnChainPrice + collateralOffChainPrice) / 2,
  } as PriceData;
}

function computeLoanToValue(vault: AccountVaultBalance, priceData: PriceData) {
  const numerator = vault.fTokenBalance * priceData.fTokenPrice * COLLATERAL_MULTIPLIER;
  if (numerator === 0) {
    return 0;
  }
  const denominator = vault.collateralBalance * priceData.collateralCombinedPrice * FTOKEN_MULTIPLIER;
  return (100 * numerator) / denominator;
}

async function confirmExitFlund(notification: NeoNotification, inQuantity: number) {
  let exitResolve: Function;
  // eslint-disable-next-line no-unused-vars
  const swapPromise = new Promise<string>((resolve, _) => {
    exitResolve = resolve;
  });
  const swapFailedT = setTimeout(() => {
    logger.info(`FLUND exit wasn't confirmed after ${VERIFY_WAIT_MILLIS} milliseconds, but may still have succeeded`);
    // eslint-disable-next-line no-use-before-define
    notification.offCallback(exitSuccess);
    exitResolve(false);
    WebhookUtils.postExitUnconfirmed(DRY_RUN, LIQUIDATOR_NAME, FLUND_SYMBOL);
  }, VERIFY_WAIT_MILLIS);

  async function exitSuccess(
    callbackData: RawData,
    isBinary: boolean,
  ): Promise<void> {
    const message = isBinary ? callbackData : callbackData.toString();
    const data = JSON.parse(message as string);
    if (data.params) {
      const txid = data.params[0].container;
      const dataState = data.params[0].state;
      const recipientHash = dataState.value[1].value;
      const outQuantity = dataState.value[2].value;
      if (DapiUtils.base64MatchesAddress(recipientHash, OWNER.address)
       && DapiUtils.base64MatchesScriptHash(dataState.value[0].value, DapiUtils.FLUND_SCRIPT_HASH)) {
        clearTimeout(swapFailedT);
        exitResolve(txid);
        notification.offCallback(exitSuccess);
        logger.info(`FLUND exit ${txid} successful`);
        const scaledInQuantity = inQuantity / FLUND_MULTIPLIER;
        const scaledOutQuantity = outQuantity / FLM_MULTIPLIER;
        WebhookUtils.postExitSuccess(DRY_RUN, LIQUIDATOR_NAME, FLUND_SYMBOL, FLM_SYMBOL, scaledInQuantity, scaledOutQuantity);
      }
    }
  }
  notification.onCallback(DapiUtils.FLM_SCRIPT_HASH, 'Transfer', exitSuccess);
  return swapPromise;
}

async function exitFlund(
  notification: NeoNotification,
) {
  const flundBalance = await DapiUtils.getBalance(DapiUtils.FLUND_SCRIPT_HASH, OWNER);

  try {
    const transaction = await DapiUtils.exitFlund(flundBalance, OWNER);
    const scaledFlundBalance = flundBalance / FLUND_MULTIPLIER;
    const txHash = await submitTransaction(transaction, 'FLUND::withdraw()') as string;
    WebhookUtils.postExitInitiated(DRY_RUN, LIQUIDATOR_NAME, FLUND_SYMBOL, scaledFlundBalance, txHash);
    const exitComplete = confirmExitFlund(notification, flundBalance);
    await exitComplete;
  } catch (e) {
    logger.error('Failed to submit exitFlund transaction - your funds have not been sent');
    logger.error(e);
    WebhookUtils.postExitFailure(DRY_RUN, LIQUIDATOR_NAME, FLUND_SYMBOL);
  }
}
async function confirmFlamingoSwap(
  notification: NeoNotification,
  contractHash: string,
  inQuantity: number,
  fromSymbol: string,
  fromMultiplier: number,
) {
  let swapResolve: Function;
  // eslint-disable-next-line no-unused-vars
  const swapPromise = new Promise<string>((resolve, _) => {
    swapResolve = resolve;
  });
  const swapFailedT = setTimeout(() => {
    logger.info(`Flamingo swap wasn't confirmed after ${VERIFY_WAIT_MILLIS} milliseconds, but may still have succeeded`);
    // eslint-disable-next-line no-use-before-define
    notification.offCallback(swapSuccess);
    swapResolve(false);
    WebhookUtils.postSwapUnconfirmed(DRY_RUN, LIQUIDATOR_NAME, fromSymbol, FTOKEN_SYMBOL);
  }, VERIFY_WAIT_MILLIS);

  async function swapSuccess(
    callbackData: RawData,
    isBinary: boolean,
  ): Promise<void> {
    const message = isBinary ? callbackData : callbackData.toString();
    const data = JSON.parse(message as string);
    if (data.params) {
      const txid = data.params[0].container;
      const dataState = data.params[0].state;
      const recipientHash = dataState.value[1].value;
      const outQuantity = dataState.value[2].value;
      if (DapiUtils.base64MatchesAddress(recipientHash, OWNER.address)) {
        clearTimeout(swapFailedT);
        swapResolve(txid);
        notification.offCallback(swapSuccess);
        logger.info(`Flamingo swap ${txid} successful`);
        const scaledInQuantity = inQuantity / fromMultiplier;
        const scaledOutQuantity = outQuantity / FTOKEN_MULTIPLIER;
        WebhookUtils.postSwapSuccess(DRY_RUN, LIQUIDATOR_NAME, fromSymbol, FTOKEN_SYMBOL, scaledInQuantity, scaledOutQuantity);
      }
    }
  }
  notification.onCallback(contractHash, 'Transfer', swapSuccess);
  return swapPromise;
}

async function flamingoSwap(
  notification: NeoNotification,
  fromToken: string,
  toToken: string,
  fromSymbol: string,
  fromMultiplier: number,
) {
  const fromBalance = await DapiUtils.getBalance(fromToken, OWNER);

  try {
    const transaction = await DapiUtils.createFlamingoSwap(
      fromToken,
      toToken,
      fromBalance,
      0,
      OWNER,
    );
    const scaledFromBalance = fromBalance / COLLATERAL_MULTIPLIER;
    const txHash = await submitTransaction(transaction, `FlamingoSwapRouter::swapTokenInForTokenOut(${fromToken}, ${toToken})`) as string;
    WebhookUtils.postSwapInitiated(DRY_RUN, LIQUIDATOR_NAME, fromSymbol, FTOKEN_SYMBOL, scaledFromBalance, txHash);
    const swapComplete = confirmFlamingoSwap(notification, toToken, fromBalance, fromSymbol, fromMultiplier);
    await swapComplete;
  } catch (e) {
    logger.error('Failed to submit flamingoSwap transaction - your funds have not been sent');
    logger.error(e);
    WebhookUtils.postSwapFailure(DRY_RUN, LIQUIDATOR_NAME, fromSymbol, FTOKEN_SYMBOL);
  }
}

function computeLiquidateQuantity(fTokenBalance: number, vault: AccountVaultBalance, priceData: PriceData) {
  const maxFTokenQuantity = (LIQUIDATION_LIMIT * vault.fTokenBalance) / 100;
  // In the unlikely case that the Vault is under-collateralized,
  // we can only liquidate as much collateral as exists in the Vault
  // Since this is rare, we apply a conservative haircut of 90% to avoid an ABORT
  const maxCollateralQuantity = (90 * vault.collateralBalance) / (100 + LIQUIDATION_BONUS);
  const maxFTokenQuantityFromCollateral = (maxCollateralQuantity * priceData.collateralCombinedPrice * FTOKEN_MULTIPLIER) / (priceData.fTokenPrice * COLLATERAL_MULTIPLIER);
  const maxLiquidateQuantity = Math.min(maxFTokenQuantity, maxFTokenQuantityFromCollateral);
  const clippedMaxLiquidateQuantity = Math.floor(Math.min(fTokenBalance, maxLiquidateQuantity));

  logger.debug(`Computed clippedMaxLiquidateQuantity=${clippedMaxLiquidateQuantity} from`
               + ` maxFTokenQuantity=${maxFTokenQuantity}, maxCollateralQuantity=${maxCollateralQuantity},`
               + ` maxFTokenQuantityFromCollateral=${maxFTokenQuantityFromCollateral}, maxLiquidateQuantity=${maxLiquidateQuantity},`);
  return clippedMaxLiquidateQuantity;
}

/**
 * Listen to the notification subsystem to determine whether
 * a liquidation was successful
 */
async function confirmLiquidate(
  notification: NeoNotification,
  liquidatee: string,
) {
  let liquidateResolve: Function;
  // eslint-disable-next-line no-unused-vars
  const liquidatePromise = new Promise<string>((resolve, _) => {
    liquidateResolve = resolve;
  });
  const liquidateFailedT = setTimeout(() => {
    logger.info(`Liquidation wasn't confirmed after ${VERIFY_WAIT_MILLIS} milliseconds, but may still have succeeded`);
    // eslint-disable-next-line no-use-before-define
    notification.offCallback(liquidateSuccess);
    liquidateResolve(false);
    WebhookUtils.postLiquidateUnconfirmed(DRY_RUN, LIQUIDATOR_NAME, COLLATERAL_SYMBOL, FTOKEN_SYMBOL);
  }, VERIFY_WAIT_MILLIS);

  async function liquidateSuccess(
    callbackData: RawData,
    isBinary: boolean,
  ): Promise<void> {
    const message = isBinary ? callbackData : callbackData.toString();
    const data = JSON.parse(message as string);
    if (data.params && data.params[0].eventname === 'LiquidateCollateral') {
      const txid = data.params[0].container;
      const dataState = data.params[0].state;

      if (DapiUtils.base64MatchesAddress(dataState.value[2].value, OWNER.address)
       && DapiUtils.base64MatchesScriptHash(dataState.value[0].value, COLLATERAL_SCRIPT_HASH)
       && DapiUtils.base64MatchesScriptHash(dataState.value[1].value, FTOKEN_SCRIPT_HASH)
       && DapiUtils.base64MatchesScriptHash(dataState.value[3].value, liquidatee)
      ) {
        clearTimeout(liquidateFailedT);
        liquidateResolve(true);
        notification.offCallback(liquidateSuccess);
        logger.info(`Liquidation ${txid} succeeded`);
        const fTokenQuantity = (dataState.value[4].value as number) / FTOKEN_MULTIPLIER;
        const collateralQuantity = (dataState.value[5].value as number) / COLLATERAL_MULTIPLIER;
        WebhookUtils.postLiquidateSuccess(DRY_RUN, LIQUIDATOR_NAME, COLLATERAL_SYMBOL, FTOKEN_SYMBOL, fTokenQuantity, collateralQuantity);
      }
    }
  }

  notification.onCallback(DapiUtils.VAULT_SCRIPT_HASH, 'LiquidateCollateral', liquidateSuccess);
  return liquidatePromise;
}

/**
 * Liquidate a Vault. onChainPriceOnly can be set to true only for whitelisted addresses.
 *
 * If onChainPriceOnly is true, we liquidate using only on-chain prices of both the FToken and collateral asset.
 * Otherwise, we use a combination of the on-chain and off-chain price for the collateral asset.
 */
async function liquidate(
  notification: NeoNotification,
  liquidatee: string,
  liquidateQuantity: number,
  priceData: PriceData,
) {
  const liquidateComplete = confirmLiquidate(notification, liquidatee);
  const scaledLiquidateQuantity = liquidateQuantity / FTOKEN_MULTIPLIER;
  let txHash;
  if (ON_CHAIN_PRICE_ONLY) {
    const transaction = await DapiUtils.liquidateOCP(FTOKEN_SCRIPT_HASH, COLLATERAL_SCRIPT_HASH, liquidatee, liquidateQuantity, OWNER);
    txHash = await submitTransaction(transaction, `Vault::liquidateOCP(${FTOKEN_SCRIPT_HASH}, ${COLLATERAL_SCRIPT_HASH})`) as string;
  } else {
    const transaction = await DapiUtils.liquidate(FTOKEN_SCRIPT_HASH, COLLATERAL_SCRIPT_HASH, liquidatee, liquidateQuantity, priceData.payload, priceData.signature, OWNER);
    txHash = await submitTransaction(transaction, `Vault::liquidate(${FTOKEN_SCRIPT_HASH}, ${COLLATERAL_SCRIPT_HASH})`) as string;
  }
  WebhookUtils.postLiquidateInitiated(DRY_RUN, LIQUIDATOR_NAME, COLLATERAL_SYMBOL, FTOKEN_SYMBOL, scaledLiquidateQuantity, txHash);
  await liquidateComplete;
}

async function attemptLiquidation(
  notification: NeoNotification,
  fTokenBalance: number,
  vault: AccountVaultBalance,
  priceData: PriceData,
) {
  const loanToValue = computeLoanToValue(vault, priceData);
  logger.debug(`Attempting liquidation: Account: ${vault.account}, Collateral: ${COLLATERAL_SYMBOL}, FToken: ${FTOKEN_SYMBOL}, LTV: ${loanToValue}, Max LTV: ${MAX_LOAN_TO_VALUE}`);

  if (loanToValue > MAX_LOAN_TO_VALUE) {
    const liquidateQuantity = computeLiquidateQuantity(fTokenBalance, vault, priceData);
    const scaledLiquidateQuantity = liquidateQuantity / FTOKEN_MULTIPLIER;
    if (scaledLiquidateQuantity > LIQUIDATE_THRESHOLD) {
      logger.info(`Liquidating: Account: ${vault.account}, LTV: ${loanToValue}, Max LTV: ${MAX_LOAN_TO_VALUE}`);
      try {
        await liquidate(notification, vault.account, liquidateQuantity, priceData);
        return true;
      } catch (e) {
        logger.error('Failed to liquidate - your funds have not been sent');
        logger.error(e);
        WebhookUtils.postLiquidateFailure(DRY_RUN, LIQUIDATOR_NAME, COLLATERAL_SYMBOL, FTOKEN_SYMBOL);
        return false;
      }
    } else {
      logger.debug(`Did not liquidate: Account: ${vault.account}, Collateral: ${COLLATERAL_SYMBOL},`
          + ` FToken: ${FTOKEN_SYMBOL}, LTV: ${loanToValue}, Max LTV: ${MAX_LOAN_TO_VALUE}`
          + ` because liquidateQuantity=${scaledLiquidateQuantity} < LIQUIDATE_THRESHOLD=${LIQUIDATE_THRESHOLD}`);
      return false;
    }
  } else {
    logger.debug(`Did not liquidate: Account: ${vault.account}, Collateral: ${COLLATERAL_SYMBOL},`
        + ` FToken: ${FTOKEN_SYMBOL}, LTV: ${loanToValue}, Max LTV: ${MAX_LOAN_TO_VALUE}`
        + ` because loanToValue=${loanToValue} < MAX_LOAN_TO_VALUE=${MAX_LOAN_TO_VALUE}`);
    return false;
  }
}

function sleep(millis: number) {
  // eslint-disable-next-line no-promise-executor-return
  return new Promise((resolve) => setTimeout(resolve, millis));
}

// Main loop
(async () => {
  // 0. Wait for initialization
  logger.info('Starting liquidator...');

  const { address } = OWNER;
  logger.info(`Wallet address=${address}`);

  FTOKEN_SYMBOL = await DapiUtils.symbol(FTOKEN_SCRIPT_HASH);
  FTOKEN_MULTIPLIER = 10 ** (await DapiUtils.decimals(FTOKEN_SCRIPT_HASH));
  COLLATERAL_SYMBOL = await DapiUtils.symbol(COLLATERAL_SCRIPT_HASH);
  COLLATERAL_MULTIPLIER = 10 ** (await DapiUtils.decimals(COLLATERAL_SCRIPT_HASH));
  FLM_SYMBOL = await DapiUtils.symbol(DapiUtils.FLM_SCRIPT_HASH);
  FLM_MULTIPLIER = 10 ** (await DapiUtils.decimals(DapiUtils.FLM_SCRIPT_HASH));
  FLUND_SYMBOL = await DapiUtils.symbol(DapiUtils.FLUND_SCRIPT_HASH);
  FLUND_MULTIPLIER = 10 ** (await DapiUtils.decimals(DapiUtils.FLUND_SCRIPT_HASH));
  LIQUIDATION_LIMIT = await DapiUtils.getLiquidationLimit(COLLATERAL_SCRIPT_HASH);
  LIQUIDATION_BONUS = await DapiUtils.getLiquidationBonus(COLLATERAL_SCRIPT_HASH);
  MAX_LOAN_TO_VALUE = await DapiUtils.getMaxLoanToValue(COLLATERAL_SCRIPT_HASH);
  const scaledInitialFTokenBalance = await DapiUtils.getBalance(FTOKEN_SCRIPT_HASH, OWNER) / FTOKEN_MULTIPLIER;

  logger.info(`Initialized "${LIQUIDATOR_NAME}" with FToken: ${FTOKEN_SYMBOL}, Collateral: ${COLLATERAL_SYMBOL}, Max LTV: ${MAX_LOAN_TO_VALUE}, Dry Run: ${DRY_RUN}`);
  logger.info(`Initial FToken balance: ${scaledInitialFTokenBalance}`);
  logger.info(`Liquidation limit: ${LIQUIDATION_LIMIT}`);

  const notification = await NeoNotificationInit();
  await notification.available;

  WebhookUtils.postInit(DRY_RUN, LIQUIDATOR_NAME, COLLATERAL_SYMBOL, FTOKEN_SYMBOL, scaledInitialFTokenBalance);

  while (true) {
    const startMillis = new Date().getTime();

    // 1. Update prices and balance
    const priceData = await getPrices(FTOKEN_SCRIPT_HASH, COLLATERAL_SCRIPT_HASH, COLLATERAL_SYMBOL, ON_CHAIN_PRICE_ONLY);
    const fTokenBalance = await DapiUtils.getBalance(FTOKEN_SCRIPT_HASH, OWNER);
    logger.info(`Current ${FTOKEN_SYMBOL} balance: ${fTokenBalance / FTOKEN_MULTIPLIER}`);

    // 2. Notify if balance is low
    const scaledFTokenBalance = fTokenBalance / FTOKEN_MULTIPLIER;
    if (scaledFTokenBalance < LOW_BALANCE_THRESHOLD) {
      logger.warn(`Current ${FTOKEN_SYMBOL} balance=${scaledFTokenBalance} < lowBalanceThreshold=${LOW_BALANCE_THRESHOLD}`);
      WebhookUtils.postLowBalance(DRY_RUN, LIQUIDATOR_NAME, COLLATERAL_SYMBOL, FTOKEN_SYMBOL, scaledFTokenBalance, LOW_BALANCE_THRESHOLD);
    }

    // 3. Loop over vaults and liquidate the first possible vault
    let pageNum = 0;
    let liquidationSuccess = false;
    while (true) {
      const vaults = (await DapiUtils.getAllVaults(COLLATERAL_SCRIPT_HASH, FTOKEN_SCRIPT_HASH, MAX_PAGE_SIZE, pageNum))
        .sort(() => Math.random() - 0.5);
      for (let i = 0; i < vaults.length; i++) {
        if (vaults[i].collateralBalance > 0) {
          liquidationSuccess = await attemptLiquidation(
            notification,
            fTokenBalance,
            vaults[i],
            priceData,
          );
          if (liquidationSuccess) {
            break;
          }
        }
      }
      if (vaults.length === 0 || liquidationSuccess) {
        break;
      }
      pageNum += 1;
    }

    const collateralBalance = await DapiUtils.getBalance(COLLATERAL_SCRIPT_HASH, OWNER);
    logger.info(`Current ${COLLATERAL_SYMBOL} balance: ${collateralBalance / COLLATERAL_MULTIPLIER}`);

    // 4. Swap collateral back to FToken if desired
    if (AUTO_SWAP && collateralBalance > SWAP_THRESHOLD) {
      // For FLUND, we first need to convert to FLM
      if (COLLATERAL_SCRIPT_HASH === DapiUtils.FLUND_SCRIPT_HASH) {
        await exitFlund(notification);
        await flamingoSwap(notification, DapiUtils.FLM_SCRIPT_HASH, FTOKEN_SCRIPT_HASH, FLM_SYMBOL, FLM_MULTIPLIER);
      } else {
        await flamingoSwap(notification, COLLATERAL_SCRIPT_HASH, FTOKEN_SCRIPT_HASH, COLLATERAL_SYMBOL, COLLATERAL_MULTIPLIER);
      }
    }

    // 5. Rest after a job well done
    const elapsedMillis = new Date().getTime() - startMillis;
    const remainingMillis = Math.max(0, SLEEP_MILLIS - elapsedMillis);
    if (remainingMillis > 0) {
      logger.info(`Sleeping ${remainingMillis} milliseconds...`);
      await sleep(remainingMillis);
    }
  }
})();
