/* eslint-disable no-plusplus */
/* eslint-disable no-constant-condition */
/* eslint-disable max-len */
/* eslint-disable no-await-in-loop */
import { tx, wallet } from '@cityofzion/neon-core';
import { RawData } from 'ws';
import { config } from './config';
import { logger } from './utils/loggingUtils';

import { AccountVaultBalance, DapiUtils, MAINTAIN_COLLATERAL } from './utils/dapiUtils';
import { NeoNotification, NeoNotificationInit } from './utils/notificationUtils';
import { WebhookUtils } from './utils/webhookUtils';

const properties = config.getProperties();

const PRIVATE_KEY: string = properties.privateKey;
const OWNER: wallet.Account = new wallet.Account(PRIVATE_KEY);
const DRY_RUN: boolean = properties.dryRun;
const FTOKEN_SCRIPT_HASH = properties.fTokenScriptHash; // fUSD
const COLLATERAL_SCRIPT_HASH = properties.collateralScriptHash; // FLUND | bNEO | fWBTC
const ON_CHAIN_PRICE_ONLY = properties.onChainPriceOnly;
const ON_CHAIN_PRICE_DECIMALS = 20;
const MAINTAINER_NAME = properties.maintainerName;
const MAINTENANCE_THRESHOLD = properties.maintenanceThreshold;
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
let MAINTENANCE_LIMIT: number;
let MAINTENANCE_BONUS: number;

function sleep(millis: number) {
  // eslint-disable-next-line no-promise-executor-return
  return new Promise((resolve) => setTimeout(resolve, millis));
}

const isFusdt = (elm: any) => elm.symbol === 'fUSDT';
const isFusd = (elm: any) => elm.symbol === 'FUSD';
const isNeo = (elm: any) => elm.symbol === 'NEO';
const isBNeo = (elm: any) => elm.symbol === 'BNEO';
const isFlm = (elm: any) => elm.symbol === 'FLM';
const isGas = (elm: any) => elm.symbol === 'GAS';
const isFwbtc = (elm: any) => elm.symbol === 'fWBTC';

async function getPrices() {
  // const priceData = await DapiUtils.getPriceFeed();
  const flamingoPriceData = await DapiUtils.getFlamingoPriceFeed();
  // const { decimals } = priceData.data;
  // const decimalsFUSDT = await DapiUtils.decimals('0xcd48b160c1bbc9d74997b803b9a7ad50a4bef020');

  // const fUSDTOnChainPrice = +(await DapiUtils.getOnChainPrice('0x1005d400bcc2a56b7352f09e273be3f9933a5fb1', decimals));
  // const fUSDOnChainPrice = +(await DapiUtils.getOnChainPrice(FTOKEN_SCRIPT_HASH, decimals));

  const fusdt = flamingoPriceData.find(isFusdt);
  const fusd = flamingoPriceData.find(isFusd);
  const neo = flamingoPriceData.find(isNeo);
  const bneo = flamingoPriceData.find(isBNeo);
  const gas = flamingoPriceData.find(isGas);
  const flm = flamingoPriceData.find(isFlm);
  const fwbtc = flamingoPriceData.find(isFwbtc);

  return {
    // payload: priceData.payload,
    // signature: priceData.signature,
    // decimals: priceData.data.decimals,
    fusdt,
    fusd,
    neo: neo.usd_price,
    bneo,
    gas: gas.usd_price,
    flm: flm.usd_price,
    fwbtc: fwbtc.usd_price,
    // decimalsFUSDT,
    // fUSD: fUSDOnChainPrice,
    // flamingoPayload: flamingoPriceData,
    // fUSDT: fUSDTOnChainPrice,
  };
}

// Main loop
(async () => {
  // 0. Wait for initialization
  logger.info('🟢 Starting arb bot...');

  const { address } = OWNER;
  logger.info(`💰 Wallet address=${address}`);

  FTOKEN_SYMBOL = await DapiUtils.symbol(FTOKEN_SCRIPT_HASH);
  FTOKEN_MULTIPLIER = 10 ** (await DapiUtils.decimals(FTOKEN_SCRIPT_HASH));
  COLLATERAL_SYMBOL = await DapiUtils.symbol(COLLATERAL_SCRIPT_HASH);
  COLLATERAL_MULTIPLIER = 10 ** (await DapiUtils.decimals(COLLATERAL_SCRIPT_HASH));
  FLM_SYMBOL = await DapiUtils.symbol(DapiUtils.FLM_SCRIPT_HASH);
  FLM_MULTIPLIER = 10 ** (await DapiUtils.decimals(DapiUtils.FLM_SCRIPT_HASH));
  FLUND_SYMBOL = await DapiUtils.symbol(DapiUtils.FLUND_SCRIPT_HASH);
  FLUND_MULTIPLIER = 10 ** (await DapiUtils.decimals(DapiUtils.FLUND_SCRIPT_HASH));
  MAINTENANCE_LIMIT = await DapiUtils.getMaintenanceLimit(COLLATERAL_SCRIPT_HASH);
  MAINTENANCE_BONUS = await DapiUtils.getMaintenanceBonus(COLLATERAL_SCRIPT_HASH);
  MAX_LOAN_TO_VALUE = await DapiUtils.getMaxLoanToValue(COLLATERAL_SCRIPT_HASH);
  // const scaledInitialFTokenBalance = await DapiUtils.getBalance(FTOKEN_SCRIPT_HASH, OWNER) / FTOKEN_MULTIPLIER;

  logger.info(`Initialized "${MAINTAINER_NAME}" with FToken: ${FTOKEN_SYMBOL}, Collateral: ${COLLATERAL_SYMBOL}, Max LTV: ${MAX_LOAN_TO_VALUE}, Dry Run: ${DRY_RUN}`);
  // logger.info(`Initial FToken balance: ${scaledInitialFTokenBalance}`);
  logger.info(`Maintenance limit: ${MAINTENANCE_LIMIT}`);

  const notification = await NeoNotificationInit();
  await notification.available;

  // WebhookUtils.postInit(DRY_RUN, MAINTAINER_NAME, COLLATERAL_SYMBOL, FTOKEN_SYMBOL, scaledInitialFTokenBalance);

  while (true) {
    const startMillis = new Date().getTime();

    // 1. Update prices and balance
    // const priceData = await getPrices(FTOKEN_SCRIPT_HASH, COLLATERAL_SCRIPT_HASH, COLLATERAL_SYMBOL, ON_CHAIN_PRICE_ONLY);
    // const fTokenBalance = await DapiUtils.getBalance(FTOKEN_SCRIPT_HASH, OWNER);
    // logger.info(`🏦 ${FTOKEN_SYMBOL} balance: ${fTokenBalance / FTOKEN_MULTIPLIER}`);

    // 2. Notify if balance is low
    // const scaledFTokenBalance = fTokenBalance / FTOKEN_MULTIPLIER;
    // if (scaledFTokenBalance < LOW_BALANCE_THRESHOLD) {
    //  logger.warn(`⛑⛑⛑ ${FTOKEN_SYMBOL} balance=${scaledFTokenBalance} < lowBalanceThreshold=${LOW_BALANCE_THRESHOLD} ⛑⛑⛑`);
    //  WebhookUtils.postLowBalance(DRY_RUN, MAINTAINER_NAME, COLLATERAL_SYMBOL, FTOKEN_SYMBOL, scaledFTokenBalance, LOW_BALANCE_THRESHOLD);
    // }

    // 3. Get prices & balances
    const priceData1 = await getPrices();
    const walletFusdBalance = await DapiUtils.getBalance(priceData1.fusd.hash, OWNER);
    const fusdTokenMultiplier = 10 ** (await DapiUtils.decimals(priceData1.fusd.hash));
    const walletFusdtBalance = await DapiUtils.getBalance(priceData1.fusdt.hash, OWNER);
    const fusdtTokenMultiplier = 10 ** (await DapiUtils.decimals(priceData1.fusdt.hash));
    logger.info(` ${JSON.stringify(priceData1)}`);
    logger.info(`🏦 ${priceData1.fusd.symbol} balance: ${walletFusdBalance / fusdTokenMultiplier} price: ${priceData1.fusd.usd_price}`);
    logger.info(`🏦 ${priceData1.fusdt.symbol} balance: ${walletFusdtBalance / fusdtTokenMultiplier} price: ${priceData1.fusdt.usd_price}`);

    // 4. Get existing trades
    // https://neo3.neotube.io/address/NU8yeRDnUrkgP4h5hsUSbe9nQnvHUdxQpG
    // https://api.neotube.io/v1/address/txs?address=NU8yeRDnUrkgP4h5hsUSbe9nQnvHUdxQpG&page=1&page_size=10
    // https://api.neotube.io/v1/tx/0x7e02e205f8aafa2de491825f2139788785ae4739be641882ce048aed6dc221e3?details=basic

    // 5. loop thru existing trades
    //    4.a  if trade is profitable sell it


    // 6. Rest after a job well done
    const elapsedMillis = new Date().getTime() - startMillis;
    const remainingMillis = Math.max(0, SLEEP_MILLIS - elapsedMillis);
    if (remainingMillis > 0) {
      logger.info(`💤💤💤 ${remainingMillis} milliseconds... 💤💤💤`);
      await sleep(remainingMillis);
    }
  }
})();
