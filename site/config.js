// Fill PAD after deploying SqueekPad (deploy.html prints both values).
window.SQUEEKPAD_CONFIG = {
  PAD: "0x96C1C5978B1A782099Cf2FCd80558d0a1BCe14d1", // SqueekPad on Sepolia
  PAD_BLOCK: 12066969,     // deploy block (logs are read from here)
  CHAIN_ID: 11155111,
  RPC: "https://ethereum-sepolia-rpc.publicnode.com",
  EXPLORER: "https://sepolia.etherscan.io",
  STATUS_API: "https://api.squeekchain.com/v1/status",
  // Deployment constants (Sepolia)
  SQUEEK_NFT: "0xc4c7982657f00509548f3a3a41db7fa439a6856b",   // Squeek collection, from api.squeekchain.com/v1/economy/state
  UNI_V2_FACTORY: "0xF62c03E08ada871A0bEb309762E260a7a6a880E6",
  WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  VIRTUAL_ETH: "0.1",      // curve start; ~0.29 ETH raised at graduation
};
