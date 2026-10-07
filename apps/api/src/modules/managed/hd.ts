import { HDNodeWallet, getBytes } from 'ethers';

const roots = new Map<string, HDNodeWallet>();

function root(seedHex: string): HDNodeWallet {
  let node = roots.get(seedHex);
  if (!node) {
    node = HDNodeWallet.fromSeed(getBytes(seedHex));
    roots.set(seedHex, node);
  }
  return node;
}

/** Standard Ethereum derivation path for the built-in wallet with this index. */
export const walletPath = (index: number): string => `m/44'/60'/0'/0/${index}`;

/**
 * The built-in wallet for `index`. Every wallet comes from the one master seed, so the database only has to remember
 * the index: no private key is ever stored. The same seed and index always give the same wallet.
 */
export function deriveWallet(seedHex: string, index: number): HDNodeWallet {
  if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid wallet index: ${index}`);
  return root(seedHex).derivePath(walletPath(index));
}

/** Lower-cased address of the built-in wallet with this index. */
export function deriveAddress(seedHex: string, index: number): string {
  return deriveWallet(seedHex, index).address.toLowerCase();
}
