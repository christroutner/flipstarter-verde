const buffer = require("buffer/").Buffer;
const libauth = require("@bitauth/libauth");
const contract = require("./src/assurance").Contract;
const QrCode = require("./src/qrcode.js");

// Global exports...
window.Buffer = buffer;
window.libauth = libauth;

class Wallet {
    static async create() {
        const crypto = await libauth.instantiateBIP32Crypto();

        return new Wallet(crypto);
    }

    static fromHexString(hexString) {
        return new Uint8Array(hexString.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    }

    static toHexString(bytes) {
        return bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');
    }


    #_crypto = null;
    #_privateKey = null;

    constructor(crypto) {
        this._crypto = crypto;

        this._privateKey = libauth.generatePrivateKey(function() {
            return window.crypto.getRandomValues(new Uint8Array(32))
        });

        // TODO: Hardcoded private key for debugging... DO NOT USE
        // this._privateKey = Wallet.fromHexString("A7A117BE6E294242C997B34F0EC8F41EC9F104B445712B1AA41C0D38C204C879");
    }

    getAddress() {
        const publicKey = this._crypto.secp256k1.derivePublicKeyCompressed(this._privateKey);
        const hash = this._crypto.ripemd160.hash(this._crypto.sha256.hash(publicKey));
        return libauth.encodeCashAddress(libauth.CashAddressNetworkPrefix.mainnet, libauth.CashAddressVersionByte.P2PKH, hash);
    }

    createQrCode(widthPx, amount) {
        const width = widthPx || 82;
        const address = this.getAddress();

        const qr = QrCode(0, "M");
        qr.addData(address + "?amount=" + amount);
        qr.make();
        const html = qr.createImgTag();

        const divElement = document.createElement("div");
        divElement.innerHTML = html;
        const imgElement = divElement.firstElementChild;

        imgElement.setAttribute("width", width);
        imgElement.setAttribute("height", width);

        return imgElement;
    }

    createRefundTransaction(transactionToSpendHex, returnAddressString) {
        const wallet = this;
        const publicKey = wallet._crypto.secp256k1.derivePublicKeyCompressed(wallet._privateKey);
        const addressHash = wallet._crypto.ripemd160.hash(wallet._crypto.sha256.hash(publicKey));

        const transactionToSpendBytes = libauth.hexToBin(transactionToSpendHex);
        const transactionToSpendHash = (function() {
            const hashReverseEndian = (wallet._crypto.sha256.hash(wallet._crypto.sha256.hash(transactionToSpendBytes)));
            hashReverseEndian.reverse();
            return hashReverseEndian;
        })();
        const transactionToSpend = libauth.decodeTransactionUnsafe(transactionToSpendBytes);

        const outputIndexToSpend = (function() {
            const expectedOutputLockingScript = ("76a914" + libauth.binToHex(addressHash) + "88ac");
            for (let outputIndex in transactionToSpend.outputs) {
                const transactionOutput = transactionToSpend.outputs[outputIndex];
                if (libauth.binToHex(transactionOutput.lockingBytecode) == expectedOutputLockingScript) {
                    const outputAmount = libauth.binToBigIntUint64LE(transactionOutput.satoshis);
                    if (outputAmount == donationAmount) {
                        return outputIndex;
                    }
                }
            }
            return null;
        })();
        if (outputIndexToSpend == null) { return null; }

        const outputToSpend = transactionToSpend.outputs[outputIndexToSpend];
        const outputs = (function() {
            const miningFee = 546;
            const refundAmount = libauth.binToBigIntUint64LE(outputToSpend.satoshis) - miningFee;

            const lockingScript = contract.getLockscriptFromAddress(returnAddressString);
            const satoshis = contract.encodeOutputValue(refundAmount);
            return [{
                "satoshis": satoshis,
                "lockingBytecode": lockingScript
            }];
        })();

        const sequenceNumber = 4294967295;
        const signingSerialization = libauth.generateSigningSerializationBCH({
            correspondingOutput: Uint8Array.of(),
            coveredBytecode: outputToSpend.lockingBytecode,
            locktime: 0,
            outpointIndex: outputIndexToSpend,
            outpointTransactionHash: transactionToSpendHash,
            outputValue: libauth.bigIntToBinUint64LE(refundAmount),
            sequenceNumber: sequenceNumber,
            sha256: wallet._crypto.sha256,
            signingSerializationType: Uint8Array.of(libauth.SigningSerializationFlag.allOutputs | libauth.SigningSerializationFlag.forkId),
            transactionOutpoints: libauth.encodeOutpoints(transactionToSpend.inputs),
            transactionOutputs: libauth.encodeOutputsForSigning(outputs),
            transactionSequenceNumbers: libauth.encodeSequenceNumbersForSigning(transactionToSpend.inputs),
            version: 2
        });

        const signingSerializationHash = wallet._crypto.sha256.hash(wallet._crypto.sha256.hash(signingSerialization));

        // generate ecdsa signature
        const signatureFlags = Uint8Array.of(libauth.SigningSerializationFlag.allOutputs | libauth.SigningSerializationFlag.forkId);
        const rawSignature = wallet._crypto.secp256k1.signMessageHashDER(wallet._privateKey, signingSerializationHash);
        const libauthSig = libauth.flattenBinArray([rawSignature, signatureFlags]);

        // applying a signature to transaction
        const unlockingScript = libauth.flattenBinArray([
            libauth.encodeDataPush(libauthSig),
            libauth.encodeDataPush(publicKey),
        ]);

        transaction.inputs[0].unlockingBytecode = unlockingScript;
        const transactionBytes = libauth.encodeTransactionUnsafe(transaction);
        return Wallet.toHexString(transactionBytes);
    }

    createPledge(transactionToSpendHex, contractRecipients, donationAmount, alias, comment) {
        const wallet = this;
        const serializeContractOutputs = function(recipientOutputs) {
            const outputs = [];
            for (const outputIndex in recipientOutputs) {
                const output = recipientOutputs[outputIndex];
                const lockingScript = contract.getLockscriptFromAddress(output.user_address);
                const satoshis = contract.encodeOutputValue(output.recipient_satoshis);
                outputs.push({
                    "satoshis": satoshis,
                    "lockingBytecode": lockingScript
                });
            }
            return outputs;
        };

        const publicKey = wallet._crypto.secp256k1.derivePublicKeyCompressed(wallet._privateKey);
        const addressHash = wallet._crypto.ripemd160.hash(wallet._crypto.sha256.hash(publicKey));

        const transactionToSpendBytes = libauth.hexToBin(transactionToSpendHex);
        const transactionToSpendHash = (function() {
            const hashReverseEndian = (wallet._crypto.sha256.hash(wallet._crypto.sha256.hash(transactionToSpendBytes)));
            hashReverseEndian.reverse();
            return hashReverseEndian;
        })();
        const transactionToSpend = libauth.decodeTransactionUnsafe(transactionToSpendBytes);

        const outputIndexToSpend = (function() {
            const expectedOutputLockingScript = ("76a914" + libauth.binToHex(addressHash) + "88ac");
            for (let outputIndex in transactionToSpend.outputs) {
                const transactionOutput = transactionToSpend.outputs[outputIndex];
                if (libauth.binToHex(transactionOutput.lockingBytecode) == expectedOutputLockingScript) {
                    const outputAmount = libauth.binToBigIntUint64LE(transactionOutput.satoshis);
                    if (outputAmount == donationAmount) {
                        return outputIndex;
                    }
                }
            }
            return null;
        })();
        if (outputIndexToSpend == null) { return null; }

        const outputToSpend = transactionToSpend.outputs[outputIndexToSpend];

        const contractOutputs = serializeContractOutputs(contractRecipients);

        const sequenceNumber = 4294967295;
        const signingSerialization = libauth.generateSigningSerializationBCH({
            correspondingOutput: Uint8Array.of(),
            coveredBytecode: outputToSpend.lockingBytecode,
            locktime: 0,
            outpointIndex: outputIndexToSpend,
            outpointTransactionHash: transactionToSpendHash,
            outputValue: outputToSpend.satoshis,
            sequenceNumber: sequenceNumber,
            sha256: wallet._crypto.sha256,
            signingSerializationType: Uint8Array.of(libauth.SigningSerializationFlag.singleInput | libauth.SigningSerializationFlag.allOutputs | libauth.SigningSerializationFlag.forkId),
            transactionOutpoints: libauth.encodeOutpoints(transactionToSpend.inputs),
            transactionOutputs: libauth.encodeOutputsForSigning(contractOutputs),
            transactionSequenceNumbers: libauth.encodeSequenceNumbersForSigning(transactionToSpend.inputs),
            version: 2
        });

        const signingSerializationHash = wallet._crypto.sha256.hash(wallet._crypto.sha256.hash(signingSerialization));

        // generate ecdsa signature
        const signatureFlags = Uint8Array.of(libauth.SigningSerializationFlag.singleInput | libauth.SigningSerializationFlag.allOutputs | libauth.SigningSerializationFlag.forkId);
        const rawSignature = wallet._crypto.secp256k1.signMessageHashDER(wallet._privateKey, signingSerializationHash);
        const libauthSig = libauth.flattenBinArray([rawSignature, signatureFlags]);

        // applying a signature to transaction
        const unlockingScript = libauth.flattenBinArray([
            libauth.encodeDataPush(libauthSig),
            libauth.encodeDataPush(publicKey),
        ]);

        const pledge = {
            "inputs": [{
                "previous_output_transaction_hash": libauth.binToHex(transactionToSpendHash),
                "previous_output_index": outputIndexToSpend,
                "sequence_number": sequenceNumber,
                "unlocking_script": libauth.binToHex(unlockingScript),
            }],
            "data": {
                "alias": alias,
                "comment": comment,
            },
            "data_signature": null
        };

        return window.btoa(JSON.stringify(pledge));
    };

    getPrivateKey() {
        return libauth.encodePrivateKeyWif(this._crypto.sha256, this._privateKey, "mainnet");
    }
}

window.Wallet = Wallet;
window.setTimeout(async function() {
    const wallet = await Wallet.create();
    window.Wallet.instance = wallet;
}, 0);
