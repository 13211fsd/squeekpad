// End-to-end tests on a local ganache chain with the real Uniswap V2 factory + WETH9 bytecode.
// Run: npm test
const assert = require("assert");
const ganache = require("ganache");
const { ethers } = require("ethers");
const pad = require("../build/SqueekPad.json");
const tokenArt = require("../build/SqueekPadToken.json");
const mock = require("../build/MockSqueek.json");
const rej = require("../build/Rejector.json");
const imgArt = require("../build/SqueekPadImages.json");
const uniF = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const uniP = require("@uniswap/v2-core/build/UniswapV2Pair.json");
const weth9 = require("@uniswap/v2-periphery/build/WETH9.json");

const E = ethers.parseEther;
const VIRTUAL_ETH = E("0.1");
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + (e.shortMessage || e.message)); }
}
let IFACES = [];
function errName(e) {
  const data = e?.data || e?.info?.error?.data?.data || e?.info?.error?.data || e?.error?.data;
  const hex = typeof data === "string" ? data : data?.data;
  if (typeof hex === "string" && hex.length >= 10) {
    for (const i of IFACES) { try { return i.parseError(hex).name; } catch {} }
    return hex.slice(0, 10);
  }
  return e?.revert?.name || e?.shortMessage || e?.message || "?";
}
// fn: () => contract.method.staticCall(...)
async function reverts(fn, name) {
  try { await fn(); } catch (e) {
    const got = errName(e);
    if (name && got !== name) throw new Error(`reverted with ${got}, expected ${name}`);
    return;
  }
  throw new Error("expected revert" + (name ? " " + name : ""));
}

(async () => {
  const provider = new ethers.BrowserProvider(ganache.provider({
    logging: { quiet: true }, chain: { hardfork: "shanghai" },
    wallet: { totalAccounts: 6, defaultBalance: 1000 },
  }));
  const [deployer, alice, bob, carol, squeekHolder] = await Promise.all([0, 1, 2, 3, 4].map(i => provider.getSigner(i)));

  const deploy = async (art, signer, ...args) => {
    const f = new ethers.ContractFactory(art.abi, art.bytecode.startsWith("0x") ? art.bytecode : "0x" + art.bytecode, signer);
    const c = await f.deploy(...args); await c.waitForDeployment(); return c;
  };
  const weth = await deploy(weth9, deployer);
  const factory = await deploy(uniF, deployer, await deployer.getAddress());
  const squeeks = await deploy(mock, deployer);
  await (await squeeks.setBalance(await squeekHolder.getAddress(), 1)).wait();
  const P = await deploy(pad, deployer, VIRTUAL_ETH, await squeeks.getAddress(), await factory.getAddress(), await weth.getAddress());

  const launch = async (signer, name, sym, value = 0n) => {
    const tx = await P.connect(signer).launch(name, sym, "a test hamster coin", 0, { value });
    const rc = await tx.wait();
    const ev = rc.logs.map(l => { try { return P.interface.parseLog(l); } catch { return null; } }).find(x => x && x.name === "Launched");
    return new ethers.Contract(ev.args.token, tokenArt.abi, provider);
  };
  const bal = a => provider.getBalance(a);
  const addr = s => s.getAddress();

  IFACES = [P.interface, new ethers.Interface(tokenArt.abi), new ethers.Interface(uniP.abi)];
  console.log("SqueekPad tests");
  let tok;

  await t("launch creates a 1B token held by the pad", async () => {
    tok = await launch(alice, "Wheel Coin", "WHEEL");
    assert.equal(await tok.totalSupply(), E("1000000000"));
    assert.equal(await tok.balanceOf(await P.getAddress()), E("1000000000"));
    assert.equal(await tok.creator(), await addr(alice));
    assert.equal(await P.tokenCount(), 1n);
  });

  await t("launch rejects bad name/symbol/description", async () => {
    await reverts(async () => P.connect(alice).launch.staticCall("", "X", "", 0), "BadParams");
    await reverts(async () => P.connect(alice).launch.staticCall("A", "TOOLONGSYMBOL", "", 0), "BadParams");
    await reverts(async () => P.connect(alice).launch.staticCall("A", "B", "x".repeat(281), 0), "BadParams");
  });

  await t("buy matches quote and charges 1% fee to the creator", async () => {
    const [q] = await P.quoteBuy(await tok.getAddress(), E("0.01"), await addr(bob));
    await (await P.connect(bob).buy(await tok.getAddress(), q, { value: E("0.01") })).wait();
    assert.equal(await tok.balanceOf(await addr(bob)), q);
    assert.equal(await P.creatorFees(await addr(alice)), E("0.0001"));
  });

  await t("slippage guard reverts", async () => {
    await reverts(async () => P.connect(bob).buy.staticCall(await tok.getAddress(), E("999999999"), { value: E("0.001") }), "Slippage");
  });

  await t("Squeek NFT holder pays zero fee", async () => {
    const before = await P.creatorFees(await addr(alice));
    await (await P.connect(squeekHolder).buy(await tok.getAddress(), 0, { value: E("0.01") })).wait();
    assert.equal(await P.creatorFees(await addr(alice)), before);
    assert.equal(await P.feeBpsFor(await addr(squeekHolder)), 0n);
  });

  await t("tokens cannot move between wallets before graduation", async () => {
    await reverts(async () => tok.connect(bob).transfer.staticCall(await addr(carol), 1n), "TransfersLocked");
  });

  await t("sell returns ETH per quote without an approve", async () => {
    const amt = (await tok.balanceOf(await addr(bob))) / 2n;
    const q = await P.quoteSell(await tok.getAddress(), amt, await addr(bob));
    const f0 = await P.creatorFees(await addr(alice));
    const rc = await (await P.connect(bob).sell(await tok.getAddress(), amt, q)).wait();
    // the pad paid out exactly q to the seller (its balance drops by q; the fee stays inside as creator fees)
    const padA = await P.getAddress();
    assert.equal((await provider.getBalance(padA, rc.blockNumber - 1)) - (await provider.getBalance(padA, rc.blockNumber)), q);
    assert((await P.creatorFees(await addr(alice))) > f0);
  });

  await t("round trip never pays out more than was put in", async () => {
    const t2 = await launch(alice, "Round Trip", "RT");
    const b0 = await bal(await addr(carol));
    const rc1 = await (await P.connect(carol).buy(await t2.getAddress(), 0, { value: E("0.05") })).wait();
    const got = await t2.balanceOf(await addr(carol));
    const rc2 = await (await P.connect(carol).sell(await t2.getAddress(), got, 0)).wait();
    const gas = rc1.gasUsed * rc1.gasPrice + rc2.gasUsed * rc2.gasPrice;
    const delta = (await bal(await addr(carol))) + gas - b0;
    assert(delta < 0n, "round trip should lose the fees");
    const c = await P.curves(await t2.getAddress());
    assert(c.realEth >= 0n);
    assert(c.vEth >= VIRTUAL_ETH, "virtual ETH never drops below the start");
  });

  await t("pad ETH always covers every curve's realEth + unclaimed fees", async () => {
    let owed = 0n;
    for (let i = 0n; i < await P.tokenCount(); i++) owed += (await P.curves(await P.allTokens(i))).realEth;
    for (const s of [alice, bob, carol]) owed += await P.creatorFees(await addr(s));
    assert(await bal(await P.getAddress()) >= owed);
  });

  let pairAddr;
  await t("big buy graduates: exact refund, Uniswap pool seeded, LP burned", async () => {
    const t3 = await launch(bob, "Zoomies", "ZOOM");
    const b0 = await bal(await addr(carol));
    const rc = await (await P.connect(carol).buy(await t3.getAddress(), 0, { value: E("5") })).wait();
    const spent = b0 - (await bal(await addr(carol))) - rc.gasUsed * rc.gasPrice;
    const c = await P.curves(await t3.getAddress());
    assert.equal(c.graduated, true);
    assert.equal(c.sold, E("800000000"));
    assert.equal(c.realEth, 0n);
    assert(spent < E("0.4"), "refunded the excess, spent " + ethers.formatEther(spent));
    assert.equal(await t3.balanceOf(await addr(carol)), E("800000000"));
    pairAddr = c.pair;
    const pair = new ethers.Contract(pairAddr, uniP.abi, provider);
    const [r0, r1] = await pair.getReserves();
    const tokIsT0 = (await pair.token0()).toLowerCase() === (await t3.getAddress()).toLowerCase();
    const [rt, re] = tokIsT0 ? [r0, r1] : [r1, r0];
    assert.equal(rt, E("200000000"));
    assert(re > E("0.28") && re < E("0.3"), "pool ETH " + ethers.formatEther(re));
    assert.equal(await pair.balanceOf("0x000000000000000000000000000000000000dEaD") > 0n, true);
    // graduation price ≈ last curve price (within 2%)
    const curvePrice = Number(c.vEth) / Number(c.vTok), poolPrice = Number(re) / Number(rt);
    assert(Math.abs(poolPrice / curvePrice - 1) < 0.02, `pool ${poolPrice} vs curve ${curvePrice}`);
    // after graduation, transfers are free and curve trading is closed
    await (await t3.connect(carol).transfer(await addr(bob), 1n)).wait();
    await reverts(async () => P.connect(bob).buy.staticCall(await t3.getAddress(), 0, { value: E("0.01") }), "AlreadyGraduated");
    await reverts(async () => P.connect(carol).sell.staticCall(await t3.getAddress(), 1n, 0), "AlreadyGraduated");
  });

  await t("graduation still works if someone pre-created the pair and donated WETH", async () => {
    const t4 = await launch(bob, "Grief Test", "GRIEF");
    await (await factory.createPair(await t4.getAddress(), await weth.getAddress())).wait();
    const p4 = await factory.getPair(await t4.getAddress(), await weth.getAddress());
    await (await weth.connect(alice).deposit({ value: E("1") })).wait();
    await (await weth.connect(alice).transfer(p4, E("1"))).wait();
    await (await new ethers.Contract(p4, uniP.abi, alice).sync()).wait();
    try { await P.connect(carol).buy.staticCall(await t4.getAddress(), 0, { value: E("5") }); }
    catch (e) { throw new Error("graduation reverted: " + errName(e)); }
    await (await P.connect(carol).buy(await t4.getAddress(), 0, { value: E("5"), gasLimit: 6_000_000 })).wait();
    assert.equal((await P.curves(await t4.getAddress())).graduated, true);
  });

  await t("creator claims fees once", async () => {
    const f = await P.creatorFees(await addr(alice), { blockTag: await provider.getBlockNumber() });
    assert(f > 0n);
    const rc = await (await P.connect(alice).claimFees()).wait();
    const padA = await P.getAddress();
    assert.equal((await provider.getBalance(padA, rc.blockNumber - 1)) - (await provider.getBalance(padA, rc.blockNumber)), f);
    const ev = rc.logs.map(l => { try { return P.interface.parseLog(l); } catch { return null; } }).find(x => x && x.name === "FeesClaimed");
    assert.equal(ev.args.amount, f);
    assert.equal(await P.creatorFees(await addr(alice)), 0n);
    await reverts(async () => P.connect(alice).claimFees.staticCall(), "ZeroAmount");
  });

  await t("launch with an initial buy goes to the creator", async () => {
    const t5 = await launch(carol, "Dev Buy", "DEV", E("0.02"));
    assert((await t5.balanceOf(await addr(carol))) > 0n);
  });

  await t("unknown token reverts", async () => {
    await reverts(async () => P.connect(bob).buy.staticCall(ethers.ZeroAddress, 0, { value: 1n }), "UnknownToken");
  });

  await t("a contract that rejects ETH cannot strand a refund (whole tx reverts)", async () => {
    const t6 = await launch(bob, "Refund", "RF");
    const r = await deploy(rej, deployer);
    const data = P.interface.encodeFunctionData("buy", [await t6.getAddress(), 0]);
    await reverts(async () => r.callPad.staticCall(await P.getAddress(), data, { value: E("5") }));
    assert.equal((await P.curves(await t6.getAddress())).graduated, false);
  });

  await t("images: only the coin's creator can set one, with size/mime limits", async () => {
    const reg = await deploy(imgArt, deployer, await P.getAddress());
    IFACES.push(reg.interface);
    const t7 = await launch(alice, "Pic Coin", "PIC");
    const png = "0x89504e470d0a1a0a" + "00".repeat(100);
    const rc = await (await reg.connect(alice).setImage(await t7.getAddress(), "image/png", png)).wait();
    const ev = reg.interface.parseLog(rc.logs[0]);
    assert.equal(ev.args.token, await t7.getAddress());
    assert.equal(ev.args.data, png);
    await reverts(async () => reg.connect(bob).setImage.staticCall(await t7.getAddress(), "image/png", png), "NotCreator");
    await reverts(async () => reg.connect(alice).setImage.staticCall(await t7.getAddress(), "image/svg+xml", png), "BadImage");
    await reverts(async () => reg.connect(alice).setImage.staticCall(await t7.getAddress(), "image/png", "0x" + "00".repeat(24001)), "BadImage");
    await reverts(async () => reg.connect(alice).setImage.staticCall(await addr(bob), "image/png", png), "NotCreator");
    // a coin from a different pad is rejected
    const P2 = await deploy(pad, deployer, VIRTUAL_ETH, await squeeks.getAddress(), await factory.getAddress(), await weth.getAddress());
    const rc2 = await (await P2.connect(alice).launch("Other", "OTH", "", 0)).wait();
    const other = rc2.logs.map(l => { try { return P2.interface.parseLog(l); } catch { return null; } }).find(x => x && x.name === "Launched").args.token;
    await reverts(async () => reg.connect(alice).setImage.staticCall(other, "image/png", png), "NotCreator");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
