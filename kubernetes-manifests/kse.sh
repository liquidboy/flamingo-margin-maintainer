#!/usr/bin/env bash
read -ra SECRETS <<< $(keepassxc-cli show -a Notes "${HOME}/Downloads/FlamingoPasswords.kdbx" "neo.secrets")

#
#envFrom:
#  - secretRef:
#      name: maintainer-secrets

#❯ ll /usr/local/bin/keepassxc-cli
#Permissions Links Size User     Group Date Modified Name
#lrwxr-xr-x@     1   56 matevans wheel 22 Sep  2023  /usr/local/bin/keepassxc-cli -> /Applications/KeePassXC.app/Contents/MacOS/keepassxc-cli                                                                                                            /0.3s

encode() {
	for SECRET in "${SECRETS[@]}"; do
		IFS='=' read -ra PARTS <<< "$SECRET"

		ENCODED=$(echo -n "${PARTS[1]}" | base64)
		echo "    ${PARTS[0]}: $ENCODED"
	done
}

ENCODED_SECRETS=$(encode)

RESULT=$(cat <<EOF
  apiVersion: v1
  kind: Secret
  metadata:
    name: maintainer-neo-secrets
  type: Opaque
  data:
$ENCODED_SECRETS
EOF
)

echo "$RESULT" | kubectl apply -f -

read -ra SECRETS <<< $(keepassxc-cli show -a Notes "${HOME}/Downloads/FlamingoPasswords.kdbx" "flund.secrets")
ENCODED_SECRETS=$(encode)
RESULT=$(cat <<EOF
  apiVersion: v1
  kind: Secret
  metadata:
    name: maintainer-flund-secrets
  type: Opaque
  data:
$ENCODED_SECRETS
EOF
)
echo "$RESULT" | kubectl apply -f -


read -ra SECRETS <<< $(keepassxc-cli show -a Notes "${HOME}/Downloads/FlamingoPasswords.kdbx" "btc.secrets")
ENCODED_SECRETS=$(encode)
RESULT=$(cat <<EOF
  apiVersion: v1
  kind: Secret
  metadata:
    name: maintainer-btc-secrets
  type: Opaque
  data:
$ENCODED_SECRETS
EOF
)
echo "$RESULT" | kubectl apply -f -

read -ra SECRETS <<< $(keepassxc-cli show -a Notes "${HOME}/Downloads/FlamingoPasswords.kdbx" "btc.secrets")
ENCODED_SECRETS=$(encode)
RESULT=$(cat <<EOF
  apiVersion: v1
  kind: Secret
  metadata:
    name: maintainer-weth-secrets
  type: Opaque
  data:
$ENCODED_SECRETS
EOF
)
echo "$RESULT" | kubectl apply -f -