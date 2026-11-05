// UI end-to-end: ganache (chainId 11155111) + real Uniswap V2 + SqueekPad, driven through the site in headless Chrome
// with an injected wallet that forwards to ganache's unlocked accounts.
// Usage: node test/e2e.js <chrome.exe> <puppeteer-core dir> <screenshot dir>
const path = require("path"), fs = require("fs"), http = require("http");
const ganache = require("ganache");
const { ethers } = require("ethers");
const [, , CHROME, PPT, SHOTS] = process.argv;
const puppeteer = require(path.join(PPT, "node_modules/puppeteer-core"));
const art = n => require(n);
const site = path.join(__dirname, "../site");

(async () => {
  const g = ganache.server({ logging: { quiet: true }, chain: { chainId: 11155111, hardfork: "shanghai" }, wallet: { deterministic: true, totalAccounts: 3, defaultBalance: 100 } });
  await g.listen(8545);
  const prov = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  const dep = await prov.getSigner(0);
  const d = async (a, ...args) => { const f = new ethers.ContractFactory(a.abi, a.bytecode.startsWith("0x") ? a.bytecode : "0x" + a.bytecode, dep); const c = await f.deploy(...args); await c.waitForDeployment(); return c; };
  const weth = await d(art("@uniswap/v2-periphery/build/WETH9.json"));
  const fac = await d(art("@uniswap/v2-core/build/UniswapV2Factory.json"), await dep.getAddress());
  const sq = await d(art("../build/MockSqueek.json"));
  const pad = await d(art("../build/SqueekPad.json"), ethers.parseEther("0.1"), await sq.getAddress(), await fac.getAddress(), await weth.getAddress());
  const PAD = await pad.getAddress();
  const user = (await prov.listAccounts())[1].address;

  const srv = http.createServer((q, r) => {
    let f = decodeURIComponent(q.url.split("?")[0].split("#")[0]); if (f === "/") f = "/index.html";
    if (f === "/config.js") {
      r.setHeader("Content-Type", "text/javascript");
      return r.end(fs.readFileSync(path.join(site, "config.js"), "utf8")
        .replace('PAD: ""', `PAD: "${PAD}"`).replace("PAD_BLOCK: 0", "PAD_BLOCK: 0")
        .replace("https://ethereum-sepolia-rpc.publicnode.com", "http://127.0.0.1:8545"));
    }
    const p = path.join(site, f); if (!fs.existsSync(p)) { r.statusCode = 404; return r.end(); }
    r.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(p)] || "application/octet-stream");
    r.end(fs.readFileSync(p));
  }).listen(8766);

  const b = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const pg = await b.newPage(); await pg.setViewport({ width: 1100, height: 1300 });
  const errs = []; pg.on("pageerror", e => errs.push(e.message)); pg.on("console", m => { if (m.type() === "error" && !/favicon|squeekchain/.test(m.text())) errs.push(m.text()); });
  await pg.evaluateOnNewDocument((user) => {
    const rpc = async (method, params = []) => { const r = await fetch("http://127.0.0.1:8545", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data?.result || j.error.data; throw e; } return j.result; };
    window.ethereum = {
      isMetaMask: true, on() {}, removeListener() {},
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [user];
        if (method === "eth_chainId") return "0xaa36a7";
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "eth_sendTransaction") params[0].from = user;
        return rpc(method, params);
      },
    };
  }, user);

  const step = async (name, fn) => { try { await fn(); console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + ": " + e.message); errs.push(name); } };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const text = sel => pg.$eval(sel, e => e.innerText);
  const waitText = async (sel, re, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const t = await text(sel); if (re.test(t)) return t; } catch {} await wait(300); } throw new Error(`${sel} never matched ${re}: ${await text(sel).catch(() => "?")}`); };

  console.log("SqueekPad UI e2e");
  await pg.goto("http://localhost:8766/");
  await step("empty list renders", () => waitText("#list", /No coins yet/));
  await step("connect wallet", async () => { await pg.click("#connect"); await waitText("#connect", /0x/); });

  await step("launch with first buy -> lands on token page", async () => {
    await pg.goto("http://localhost:8766/#create"); await pg.waitForSelector("#n");
    await pg.type("#n", "Wheel <b>Coin</b>"); await pg.type("#s", "wheel"); await pg.type("#d", "Runs only when Squeektoshi runs. <script>alert(1)</script>"); await pg.type("#b", "0.01");
    await pg.click("#go");
    await pg.waitForFunction(() => location.hash.startsWith("#t-0x"), { timeout: 30000 });
    await waitText("#trades", /Buy/);
    const h1 = await text("h1"); if (!h1.includes("Wheel <b>Coin</b>")) throw new Error("name not escaped/rendered: " + h1);
  });
  await step("token page shows balance + 1% fee", async () => { await waitText("#mybal", /WHEEL/); await waitText("#myfee", /1%/); });
  await step("buy 0.05 ETH via panel", async () => {
    await pg.click('#quick [data-v="0.05"]'); await waitText("#quote", /≈/);
    await pg.click("#trade"); await wait(800); await waitText("#trades", /Buy[\s\S]*Buy/, 30000);
  });
  await step("sell 50% via panel", async () => {
    await pg.waitForSelector("#ts"); await pg.click("#ts"); await pg.click('#quick [data-p="50"]'); await waitText("#quote", /ETH/);
    await pg.click("#trade"); await waitText("#trades", /Sell/, 30000);
  });
  await step("creator fee card shows and claims", async () => {
    await pg.reload(); await pg.waitForSelector("#claim", { timeout: 15000 });
    await pg.click("#claim"); await waitText("#cmsg", /Claimed/, 30000);
  });
  await step("graduating buy -> Uniswap state", async () => {
    await pg.reload(); await pg.waitForSelector("#amt");
    await pg.type("#amt", "1"); await waitText("#quote", /graduates/);
    await pg.click("#trade"); await waitText("#app", /Graduated/, 40000);
  });
  await pg.screenshot({ path: path.join(SHOTS, "e2e_token.png"), fullPage: true });
  await step("list shows the graduated coin and stats", async () => {
    await pg.goto("http://localhost:8766/#"); await waitText("#list", /GRADUATED/); await waitText("#stats", /1 graduated/);
  });
  await pg.screenshot({ path: path.join(SHOTS, "e2e_list.png"), fullPage: true });
  await pg.setViewport({ width: 375, height: 800, isMobile: true });
  await pg.goto("http://localhost:8766/#create"); await wait(800);
  const sw = await pg.evaluate(() => document.documentElement.scrollWidth);
  console.log("  mobile scrollWidth", sw, sw <= 375 ? "ok" : "OVERFLOW");
  await pg.screenshot({ path: path.join(SHOTS, "e2e_mobile.png"), fullPage: true });
  console.log("page errors:", errs.length ? errs : "none");
  await b.close(); srv.close(); await g.close();
  process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
