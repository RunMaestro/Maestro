/**
 * electron-builder afterPack hook. electron-builder takes one hook, so each
 * package check lives in its own module and runs from here, in order. Any
 * throw fails the package before it is signed.
 */

const { default: verifyComputerHistoryHelper } = require('./verify-computer-history-helper');
const { verifyPackagedNativeAbi } = require('./verify-native-abi');

exports.default = async function afterPack(context) {
	await verifyPackagedNativeAbi(context);
	await verifyComputerHistoryHelper(context);
};
