import { Multicaller3 } from '@/lib/utils/multiCaller3';
import { Provider } from '@ethersproject/providers';
import { SubgraphPoolBase } from '@/.';
import { formatFixed } from '@ethersproject/bignumber';
import { SubgraphToken } from '@balancer-labs/sor';

const abi = [
  'function getSwapFeePercentage() view returns (uint256)',
  'function percentFee() view returns (uint256)',
  'function protocolPercentFee() view returns (uint256)',
  'function getNormalizedWeights() view returns (uint256[])',
  'function totalSupply() view returns (uint256)',
  'function getVirtualSupply() view returns (uint256)',
  'function getActualSupply() view returns (uint256)',
  'function getTargets() view returns (uint256 lowerTarget, uint256 upperTarget)',
  'function getTokenRates() view returns (uint256, uint256)',
  'function getWrappedTokenRate() view returns (uint256)',
  'function getAmplificationParameter() view returns (uint256 value, bool isUpdating, uint256 precision)',
  'function getPausedState() view returns (bool)',
  'function inRecoveryMode() view returns (bool)',
  'function getRate() view returns (uint256)',
  'function getScalingFactors() view returns (uint256[] memory)', // do we need this here?
  'function getPoolTokens(bytes32) view returns (address[], uint256[])',
];

const getTotalSupplyFn = (poolType: string) => {
  if (poolType.includes('Linear') || ['StablePhantom'].includes(poolType)) {
    return 'getVirtualSupply';
  } else if (poolType === 'ComposableStable') {
    return 'getActualSupply';
  } else {
    return 'totalSupply';
  }
};

const getSwapFeeFn = (poolType: string) => {
  if (poolType === 'Element') {
    return 'percentFee';
  } else if (poolType === 'FX') {
    return 'protocolPercentFee';
  } else {
    return 'getSwapFeePercentage';
  }
};

interface OnchainData {
  poolTokens: [string[], string[]];
  totalShares: string;
  swapFee: string;
  isPaused?: boolean;
  inRecoveryMode?: boolean;
  rate?: string;
  scalingFactors?: string[];
  weights?: string[];
  targets?: [string, string];
  wrappedTokenRate?: string;
  amp?: [string, boolean, string];
  tokenRates?: [string, string];
}

type GenericPool = SubgraphPoolBase;
//  Omit<SubgraphPoolBase | Pool, 'tokens'> & {
//   tokens: (SubgraphToken | PoolToken)[];
// };

const defaultCalls = (
  id: string,
  address: string,
  vaultAddress: string,
  poolType: string,
  multicaller: Multicaller3
) => {
  multicaller.call(`${id}.poolTokens`, vaultAddress, 'getPoolTokens', [id]);
  multicaller.call(`${id}.totalShares`, address, getTotalSupplyFn(poolType));
  multicaller.call(`${id}.swapFee`, address, getSwapFeeFn(poolType));
  // multicaller.call(`${id}.isPaused`, address, 'getPausedState');
  // multicaller.call(`${id}.inRecoveryMode`, address, 'inRecoveryMode');
  // multicaller.call(`${id}.rate`, address, 'getRate');
  // multicaller.call(`${id}.scalingFactors`, address, 'getScalingFactors');
};

const weightedCalls = (
  id: string,
  address: string,
  multicaller: Multicaller3
) => {
  multicaller.call(`${id}.weights`, address, 'getNormalizedWeights');
};

const linearCalls = (
  id: string,
  address: string,
  multicaller: Multicaller3
) => {
  multicaller.call(`${id}.targets`, address, 'getTargets');
  multicaller.call(`${id}.wrappedTokenRate`, address, 'getWrappedTokenRate');
};

const stableCalls = (
  id: string,
  address: string,
  multicaller: Multicaller3
) => {
  multicaller.call(`${id}.amp`, address, 'getAmplificationParameter');
};

const gyroECalls = (id: string, address: string, multicaller: Multicaller3) => {
  multicaller.call(`${id}.tokenRates`, address, 'getTokenRates');
};

const poolTypeCalls = (poolType: string) => {
  switch (poolType) {
    case 'Weighted':
    case 'LiquidityBootstrapping':
    case 'Investment':
      return weightedCalls;
    case 'Stable':
    case 'StablePhantom':
    case 'MetaStable':
    case 'ComposableStable':
      return stableCalls;
    case 'GyroE':
      return gyroECalls;
    default:
      if (poolType.includes('Linear')) {
        return linearCalls;
      } else {
        return () => ({}); // do nothing
      }
  }
};

const merge = (pool: GenericPool, result: OnchainData) => ({
  ...pool,
  tokens: pool.tokens.map((token) => {
    const idx = result.poolTokens[0]
      .map((t) => t.toLowerCase())
      .indexOf(token.address);
    const wrappedToken =
      pool.wrappedIndex && pool.tokensList[pool.wrappedIndex];
    return {
      ...token,
      balance: formatFixed(result.poolTokens[1][idx], token.decimals || 18),
      weight:
        (result.weights && formatFixed(result.weights[idx], 18)) ||
        token.weight,
      priceRate:
        (result.wrappedTokenRate &&
          wrappedToken &&
          wrappedToken.toLowerCase() === token.address.toLowerCase() &&
          formatFixed(result.wrappedTokenRate, 18)) ||
        token.priceRate,
    } as SubgraphToken;
  }),
  totalShares: result.totalShares
    ? formatFixed(result.totalShares, 18)
    : pool.totalShares,
  swapFee: formatFixed(result.swapFee, 18),
  amp:
    (result.amp &&
      result.amp[0] &&
      formatFixed(result.amp[0], String(result.amp[2]).length - 1)) ||
    undefined,
  lowerTarget:
    (result.targets && formatFixed(result.targets[0], 18)) || undefined,
  upperTarget:
    (result.targets && formatFixed(result.targets[1], 18)) || undefined,
  tokenRates:
    (result.tokenRates &&
      result.tokenRates.map((rate) => formatFixed(rate, 18))) ||
    undefined,
  // rate: result.rate,
  // isPaused: result.isPaused,
  // inRecoveryMode: result.inRecoveryMode,
  // scalingFactors: result.scalingFactors,
});

export const fetchOnChainPoolData = async (
  pools: {
    id: string;
    address: string;
    poolType: string;
  }[],
  vaultAddress: string,
  provider: Provider
): Promise<{ [id: string]: OnchainData }> => {
  if (pools.length === 0) {
    return {};
  }

  const multicaller = new Multicaller3(abi, provider);

  pools.forEach(({ id, address, poolType }) => {
    defaultCalls(id, address, vaultAddress, poolType, multicaller);
    poolTypeCalls(poolType)(id, address, multicaller);
  });

  // ZkEVM needs a smaller batch size
  const results = (await multicaller.execute({}, 128)) as {
    [id: string]: OnchainData;
  };

  return results;
};

export async function getOnChainBalances(
  subgraphPoolsOriginal: GenericPool[],
  _multiAddress: string,
  vaultAddress: string,
  provider: Provider
): Promise<GenericPool[]> {
  if (subgraphPoolsOriginal.length === 0) return subgraphPoolsOriginal;

  const poolsWithOnchainData: GenericPool[] = [];

  const onchainData = (await fetchOnChainPoolData(
    subgraphPoolsOriginal,
    vaultAddress,
    provider
  )) as { [id: string]: OnchainData };

  subgraphPoolsOriginal.forEach((pool) => {
    const data = onchainData[pool.id];
    poolsWithOnchainData.push(merge(pool, data));
  });

  return poolsWithOnchainData;
}
