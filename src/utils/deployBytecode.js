import { AbiCoder, concat, getBytes } from 'ethers';

/**
 * Builds the full deploy bytecode for a smart-wallet contract deployment:
 * the contract creation bytecode concatenated with the ABI-encoded constructor
 * args. This is what gets passed (with a traceId) to the universal deployer's
 * `deploy(string traceId, bytes bytecode)` function.
 *
 * Ported from the EVM service's contractDeployviaSW.
 *
 * @param {object} input
 * @param {string} input.bytecode      - contract creation bytecode (0x-prefixed or not)
 * @param {string} input.abiEncoded    - base64-encoded ABI JSON
 * @param {Array}  [input.constructorArgs] - constructor argument values
 * @returns {string} 0x-prefixed deploy bytecode
 */
export function contractDeployviaSW({ bytecode, abiEncoded, constructorArgs = [] }) {
  if (!bytecode) throw new Error('Missing bytecode for contract deployment');
  if (!abiEncoded) throw new Error('Missing abiEncoded for contract deployment');

  const normalizedBytecode = bytecode.startsWith('0x') ? bytecode : `0x${bytecode}`;

  const abiJson = Buffer.from(abiEncoded, 'base64').toString();
  const abi = JSON.parse(abiJson);
  const constructorAbi = abi.find((item) => item.type === 'constructor');

  let encodedConstructorArgs = '0x';
  if (constructorAbi?.inputs?.length) {
    const constructorTypes = constructorAbi.inputs.map((input) => input.type);
    encodedConstructorArgs = AbiCoder.defaultAbiCoder().encode(constructorTypes, constructorArgs);
  }

  return concat([getBytes(normalizedBytecode), getBytes(encodedConstructorArgs)]);
}
