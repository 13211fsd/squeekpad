"use strict";
/* SqueekPad front end. No backend: everything is read from Sepolia logs and contract views. */
const C = window.SQUEEKPAD_CONFIG;
const { ethers } = window;
const $ = s => document.querySelector(s);
const app = $("#app");

const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;
const TOTAL = 1_000_000_000n * 10n ** 18n;
const CHAIN_HEX = "0x" + C.CHAIN_ID.toString(16);

const rpc = new ethers.JsonRpcProvider(C.RPC, C.CHAIN_ID, { staticNetwork: true });
const padRead = C.PAD ? new ethers.Contract(C.PAD, window.PAD_ABI, rpc) : null;
const padIface = new ethers.Interface(window.PAD_ABI);

let account = null, signer = null, renderSeq = 0;

// ---------------------------------------------------------------- helpers
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = a => a.slice(0, 6) + "…" + a.slice(-4);
const ago = ts => { const s = Math.max(1, Math.floor(Date.now() / 1000 - ts)); return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : Math.floor(s / 86400) + "d"; };
function fmtEth(wei, d = 4) { const n = Number(ethers.formatEther(wei)); return n === 0 ? "0" : n < 10 ** -d ? "<" + 10 ** -d : n.toLocaleString(undefined, { maximumFractionDigits: d }); }
function fmtTok(wei) { const n = Number(ethers.formatEther(wei)); return n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : n.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
const priceOf = c => Number(c.vEth) / Number(c.vTok);                     // ETH per token
const mcapOf = c => priceOf(c) * 1e9;                                        // ETH, 1B supply
const progressOf = c => c.graduated ? 100 : Number((c.sold * 10000n) / CURVE_SUPPLY) / 100;
function explorer(kind, v) { return `${C.EXPLORER}/${kind}/${v}`; }
function errText(e) {
  const data = e?.data || e?.info?.error?.data;
  if (typeof data === "string" && data.length >= 10) { try { return padIface.parseError(data).name; } catch {} }
  if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "Cancelled in wallet";
  return e?.shortMessage || e?.reason || e?.message || String(e);
}
function avatar(addr, size = 44) {
  const h = parseInt(addr.slice(2, 8), 16), hue = h % 360, hue2 = (hue + 40) % 360;
  return `<svg class="avatar" width="${size}" height="${size}" viewBox="0 0 44 44" aria-hidden="true"><rect width="44" height="44" rx="12" fill="hsl(${hue2} 70% 88%)"/><ellipse cx="20" cy="28" rx="13" ry="10" fill="hsl(${hue} 60% 55%)"/><circle cx="29" cy="21" r="8" fill="hsl(${hue} 60% 55%)"/><circle cx="26" cy="14" r="3.5" fill="hsl(${hue} 60% 45%)"/><ellipse cx="32" cy="24" rx="4" ry="3" fill="#fff6ea"/><circle cx="31" cy="19" r="1.6" fill="#2b1a0e"/><circle cx="36.5" cy="21.5" r="1.2" fill="#2b1a0e"/></svg>`;
}

// chunked getLogs from the pad's deploy block
async function getLogs(filter) {
  const head = await rpc.getBlockNumber();
  const out = [];
  for (let from = C.PAD_BLOCK; from <= head; from += 40000) {
    const to = Math.min(head, from + 39999);
    out.push(...await rpc.getLogs({ ...filter, fromBlock: from, toBlock: to }));
  }
  return out;
}
const blockTs = new Map();
async function tsOf(bn, hint) {
  if (hint) return Number(hint);
  if (!blockTs.has(bn)) blockTs.set(bn, rpc.getBlock(bn).then(b => b.timestamp));
  return blockTs.get(bn);
}

// ---------------------------------------------------------------- wheel status
async function pollWheel() {
  try {
    const j = await (await fetch(C.STATUS_API, { cache: "no-store" })).json();
    const m = j.measurement || {};
    const running = m.freshness === "online" && (Number(m.speedMmPerSecond) > 0 || (m.coreStatus && m.coreStatus !== "IDLE"));
    $("#wheel").innerHTML = `<span class="dot${running ? " live" : ""}"></span><span>${running ? "Squeektoshi running · " + (Number(m.rpmMilli) / 1000).toFixed(0) + " rpm" : "Squeektoshi napping 💤"}</span>`;
  } catch { $("#wheel").innerHTML = `<span class="dot"></span><span>wheel offline</span>`; }
}
pollWheel(); setInterval(pollWheel, 10000);

// ---------------------------------------------------------------- wallet
async function connect() {
  if (!window.ethereum) { alertMsg("No browser wallet found. Install MetaMask or Rabby to trade."); return false; }
  const bp = new ethers.BrowserProvider(window.ethereum);
  const accs = await bp.send("eth_requestAccounts", []);
  account = ethers.getAddress(accs[0]);
  await ensureChain();
  signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
  $("#connect").textContent = short(account);
  checkNet();
  route();
  return true;
}
async function ensureChain() {
  const id = await window.ethereum.request({ method: "eth_chainId" });
  if (id === CHAIN_HEX) return;
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
  catch (e) {
    if (e.code === 4902) await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: CHAIN_HEX, chainName: "Sepolia", nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 }, rpcUrls: [C.RPC], blockExplorerUrls: [C.EXPLORER] }] });
    else throw e;
  }
}
async function checkNet() {
  const b = $("#netBanner");
  if (!window.ethereum || !account) { b.hidden = true; return; }
  const id = await window.ethereum.request({ method: "eth_chainId" });
  b.hidden = id === CHAIN_HEX;
  b.innerHTML = `Your wallet is on another network. <button class="btn small" id="sw">Switch to Sepolia</button>`;
  const sw = $("#sw"); if (sw) sw.onclick = () => ensureChain().then(checkNet);
}
$("#connect").onclick = () => connect().catch(e => alertMsg(errText(e)));
if (window.ethereum) {
  window.ethereum.on?.("chainChanged", () => { checkNet(); });
  window.ethereum.on?.("accountsChanged", a => { account = a[0] ? ethers.getAddress(a[0]) : null; $("#connect").textContent = account ? short(account) : "Connect"; if (account) new ethers.BrowserProvider(window.ethereum).getSigner().then(s => { signer = s; route(); }); });
}
async function needWallet() {
  if (!account) { if (!(await connect())) return null; }
  await ensureChain();
  signer = await new ethers.BrowserProvider(window.ethereum).getSigner();
  return new ethers.Contract(C.PAD, window.PAD_ABI, signer);
}
function alertMsg(t) { const m = document.querySelector(".msg"); if (m) { m.className = "msg err"; m.textContent = t; } else console.warn(t); }

// ---------------------------------------------------------------- data
let cache = { at: 0, launches: [] };
async function loadLaunches(force) {
  if (!force && Date.now() - cache.at < 15000) return cache.launches;
  const logs = await getLogs({ address: C.PAD, topics: [padIface.getEvent("Launched").topicHash] });
  const launches = await Promise.all(logs.map(async l => {
    const ev = padIface.parseLog(l);
    const c = await padRead.curves(ev.args.token);
    return {
      token: ev.args.token, creator: ev.args.creator, name: ev.args.name, symbol: ev.args.symbol,
      description: ev.args.description, block: l.blockNumber, ts: Number(c.createdAt),
      curve: { vEth: c.vEth, vTok: c.vTok, realEth: c.realEth, sold: c.sold, pair: c.pair, graduated: c.graduated },
    };
  }));
  cache = { at: Date.now(), launches };
  return launches;
}

// ---------------------------------------------------------------- views
function notDeployed() {
  app.innerHTML = `<div class="card empty"><h2>SqueekPad isn't deployed yet</h2><p>Open <a href="deploy.html">deploy.html</a>, deploy the contract from your wallet on Sepolia, then put the address and block into <code>config.js</code>.</p></div>`;
}

async function viewList() {
  app.innerHTML = `
  <section class="hero">
    <div><h1>Launch a coin. Ride the wheel.</h1>
    <p>Testnet launchpad for the Squeekchain community. Every coin starts on a bonding curve in Sepolia ETH and graduates to Uniswap V2 when 800M tokens are sold. <b>Squeek NFT holders trade fee-free.</b></p></div>
    <div class="stats" id="stats"></div>
  </section>
  <div class="toolbar">
    <input id="q" placeholder="Search name, symbol or address" aria-label="Search">
    <button class="btn small sel" data-s="new">Newest</button>
    <button class="btn small" data-s="prog">Closest to graduating</button>
    <button class="btn small" data-s="mcap">Market cap</button>
  </div>
  <div id="list" class="grid"><div class="card empty">Reading launches from Sepolia…</div></div>`;
  let sort = "new";
  const draw = (all) => {
    if (!$("#list")) return; // navigated away while loading
    const q = $("#q").value.trim().toLowerCase();
    let rows = all.filter(x => !q || x.name.toLowerCase().includes(q) || x.symbol.toLowerCase().includes(q) || x.token.toLowerCase().includes(q));
    rows.sort(sort === "new" ? (a, b) => b.block - a.block : sort === "prog" ? (a, b) => progressOf(b.curve) - progressOf(a.curve) : (a, b) => mcapOf(b.curve) - mcapOf(a.curve));
    $("#list").innerHTML = rows.length ? rows.map(card).join("") : `<div class="card empty">${all.length ? "No match." : "No coins yet — <a href='#create'>launch the first one</a>."}</div>`;
  };
  document.querySelectorAll("[data-s]").forEach(b => b.onclick = () => { sort = b.dataset.s; document.querySelectorAll("[data-s]").forEach(x => x.classList.toggle("sel", x === b)); draw(cache.launches); });
  $("#q").oninput = () => draw(cache.launches);
  try {
    const all = await loadLaunches(true);
    if (!$("#stats")) return;
    const grads = all.filter(x => x.curve.graduated).length;
    const raised = all.reduce((s, x) => s + (x.curve.graduated ? 0n : x.curve.realEth), 0n);
    $("#stats").innerHTML = `<span class="pill">${all.length} coins</span><span class="pill">${grads} graduated</span><span class="pill">${fmtEth(raised, 3)} ETH on curves</span>`;
    draw(all);
  } catch (e) { if ($("#list")) $("#list").innerHTML = `<div class="card empty">Couldn't read Sepolia (${esc(errText(e))}). <a href="#" onclick="route();return false">Retry</a></div>`; }
}

function card(x) {
  const p = progressOf(x.curve);
  return `<a class="card tok" href="#t-${x.token}">
    <div class="tokhead">${avatar(x.token)}<div><b>${esc(x.name)}</b><small>$${esc(x.symbol)} · ${ago(x.ts)} ago</small></div></div>
    <p class="desc">${esc(x.description || "")}</p>
    <div class="bar"><i style="width:${p}%"></i></div>
    <div class="row"><span>${x.curve.graduated ? '<span class="tag">GRADUATED</span>' : p.toFixed(1) + "% to graduation"}</span><span>mcap ${mcapOf(x.curve).toFixed(3)} ETH</span></div>
  </a>`;
}

function viewCreate() {
  app.innerHTML = `
  <div class="two">
    <section class="card">
      <h2>Launch a coin</h2>
      <form id="f">
        <label for="n">Name</label><input id="n" maxlength="32" required placeholder="Wheel Coin">
        <label for="s">Symbol</label><input id="s" maxlength="10" required placeholder="WHEEL" style="text-transform:uppercase">
        <label for="d">Description <small class="hint" id="dc">0/280</small></label><textarea id="d" maxlength="280" placeholder="What's the story? Keep it hamster-friendly."></textarea>
        <label for="b">Buy first (optional, Sepolia ETH)</label><input id="b" type="number" min="0" step="0.001" placeholder="0.01">
        <p class="hint">Buying in the same transaction means nobody can buy before you.</p>
        <button class="btn primary mt" id="go" type="submit">Launch on Sepolia</button>
        <p class="msg" id="msg"></p>
      </form>
    </section>
    <aside class="card">
      <h2>How it works</h2>
      <dl class="kv">
        <dt>Supply</dt><dd>1,000,000,000 fixed</dd>
        <dt>On the curve</dt><dd>800M</dd>
        <dt>Into Uniswap at graduation</dt><dd>200M + all ETH raised</dd>
        <dt>Raise to graduate</dt><dd>≈ ${(Number(C.VIRTUAL_ETH) * 2.93).toFixed(2)} ETH</dd>
        <dt>Fee</dt><dd>1% to the creator · 0% for Squeek holders</dd>
        <dt>LP tokens</dt><dd>burned</dd>
        <dt>Before graduation</dt><dd>tokens only move via the curve</dd>
        <dt>Admin keys</dt><dd>none</dd>
      </dl>
      <p class="hint">Get Sepolia ETH from any public Sepolia faucet. Testnet only — coins here are worth nothing.</p>
    </aside>
  </div>`;
  $("#d").oninput = () => $("#dc").textContent = $("#d").value.length + "/280";
  $("#f").onsubmit = async ev => {
    ev.preventDefault();
    const msg = $("#msg"); msg.className = "msg";
    const name = $("#n").value.trim(), sym = $("#s").value.trim().toUpperCase(), desc = $("#d").value.trim();
    const enc = new TextEncoder();
    if (!name || enc.encode(name).length > 32) return (msg.className = "msg err", msg.textContent = "Name: 1–32 bytes.");
    if (!sym || enc.encode(sym).length > 10) return (msg.className = "msg err", msg.textContent = "Symbol: 1–10 bytes.");
    if (enc.encode(desc).length > 280) return (msg.className = "msg err", msg.textContent = "Description: up to 280 bytes.");
    let value = 0n;
    try { value = $("#b").value ? ethers.parseEther($("#b").value) : 0n; } catch { return (msg.className = "msg err", msg.textContent = "Bad ETH amount."); }
    $("#go").disabled = true;
    try {
      const pad = await needWallet(); if (!pad) return;
      msg.textContent = "Confirm in your wallet…";
      const est = await pad.launch.estimateGas(name, sym, desc, 0, { value });
      const tx = await pad.launch(name, sym, desc, 0, { value, gasLimit: est * 13n / 10n });
      msg.innerHTML = `Sent. Waiting for Sepolia… <a href="${explorer("tx", tx.hash)}" target="_blank" rel="noopener">tx</a>`;
      const rc = await tx.wait();
      const ev2 = rc.logs.map(l => { try { return padIface.parseLog(l); } catch { return null; } }).find(x => x && x.name === "Launched");
      cache.at = 0;
      location.hash = "t-" + ev2.args.token;
    } catch (e) { msg.className = "msg err"; msg.textContent = errText(e); }
    finally { const g = $("#go"); if (g) g.disabled = false; }
  };
}

async function viewToken(addr) {
  if (!ethers.isAddress(addr)) { app.innerHTML = `<div class="card empty">Bad address.</div>`; return; }
  addr = ethers.getAddress(addr);
  app.innerHTML = `<div class="card empty">Loading coin…</div>`;
  const myRender = ++renderSeq;
  let x;
  try { x = (await loadLaunches()).find(l => l.token === addr) || (await loadLaunches(true)).find(l => l.token === addr); }
  catch (e) { app.innerHTML = `<div class="card empty">Couldn't read Sepolia (${esc(errText(e))}).</div>`; return; }
  if (!x) { app.innerHTML = `<div class="card empty">Not a SqueekPad coin.</div>`; return; }
  const c = await padRead.curves(addr);
  if (myRender !== renderSeq) return; // a newer view took over
  x.curve = { vEth: c.vEth, vTok: c.vTok, realEth: c.realEth, sold: c.sold, pair: c.pair, graduated: c.graduated };
  const p = progressOf(x.curve);
  const uni = `https://app.uniswap.org/swap?chain=sepolia&inputCurrency=ETH&outputCurrency=${addr}`;

  app.innerHTML = `
  <div class="tokhead" style="margin-bottom:12px">${avatar(addr, 56)}<div><h1 style="margin:0;font-size:1.4rem">${esc(x.name)} <small style="color:var(--muted)">$${esc(x.symbol)}</small></h1>
    <small style="color:var(--muted)">by <a href="${explorer("address", x.creator)}" target="_blank" rel="noopener">${short(x.creator)}</a> · ${ago(x.ts)} ago · <a href="${explorer("token", addr)}" target="_blank" rel="noopener">${short(addr)}</a></small></div></div>
  ${x.description ? `<p style="margin:0 0 12px;overflow-wrap:anywhere">${esc(x.description)}</p>` : ""}
  <div class="two">
    <section>
      <div class="card"><h2>Price (ETH per 1M tokens)</h2><svg class="chart" id="chart" viewBox="0 0 600 220" preserveAspectRatio="none"></svg></div>
      <div class="card mt"><h2>Trades</h2><div class="scroll"><table><thead><tr><th>Type</th><th>Trader</th><th class="num">ETH</th><th class="num">Tokens</th><th class="num">When</th></tr></thead><tbody id="trades"><tr><td colspan="5">Loading…</td></tr></tbody></table></div></div>
    </section>
    <aside>
      <div class="card">
        ${x.curve.graduated
          ? `<h2>Graduated 🎓</h2><p>This coin left the curve. Its liquidity sits in Uniswap V2 with burned LP.</p><a class="btn primary" href="${uni}" target="_blank" rel="noopener">Trade on Uniswap (Sepolia)</a><p class="hint">Pair: <a href="${explorer("address", x.curve.pair)}" target="_blank" rel="noopener">${short(x.curve.pair)}</a></p>`
          : `<div class="tabs"><button class="btn sel" id="tb">Buy</button><button class="btn" id="ts">Sell</button></div>
             <label for="amt" id="amtl">Amount (ETH)</label><input id="amt" type="number" min="0" step="any" placeholder="0.01">
             <div class="quick" id="quick"></div>
             <p class="hint" id="quote">&nbsp;</p>
             <label for="slip">Max slippage %</label><input id="slip" type="number" min="0.1" step="0.1" value="3">
             <button class="btn primary mt" id="trade" style="width:100%">Buy</button>
             <p class="msg" id="msg"></p>`}
      </div>
      <div class="card mt">
        <h2>Bonding curve</h2>
        <div class="bar"><i style="width:${p}%"></i></div>
        <p class="hint">${p.toFixed(2)}% of 800M sold</p>
        <dl class="kv">
          <dt>Price</dt><dd>${(priceOf(x.curve) * 1e6).toPrecision(4)} ETH / 1M</dd>
          <dt>Market cap</dt><dd>${mcapOf(x.curve).toFixed(4)} ETH</dd>
          <dt>ETH on curve</dt><dd>${fmtEth(x.curve.realEth)}</dd>
          <dt>Your balance</dt><dd id="mybal">${account ? "…" : "connect wallet"}</dd>
          <dt>Your fee</dt><dd id="myfee">${account ? "…" : "1% (0% with a Squeek)"}</dd>
        </dl>
      </div>
      <div class="card mt" id="feesCard" hidden></div>
    </aside>
  </div>`;

  loadTrades(addr);
  if (account) {
    const t = new ethers.Contract(addr, window.TOKEN_ABI, rpc);
    t.balanceOf(account).then(b => { const el = $("#mybal"); if (el) el.textContent = fmtTok(b) + " " + x.symbol; });
    padRead.feeBpsFor(account).then(b => { const el = $("#myfee"); if (el) el.textContent = b === 0n ? "0% — Squeek holder 🐹" : Number(b) / 100 + "%"; });
    padRead.creatorFees(account).then(f => {
      if (f === 0n) return;
      const fc = $("#feesCard"); if (!fc) return;
      fc.hidden = false;
      fc.innerHTML = `<h2>Your creator fees</h2><p>${fmtEth(f, 6)} ETH from all your coins.</p><button class="btn primary" id="claim">Claim</button><p class="msg" id="cmsg"></p>`;
      $("#claim").onclick = async () => {
        const m = $("#cmsg");
        try { const pad = await needWallet(); const tx = await pad.claimFees(); m.textContent = "Claiming…"; await tx.wait(); m.className = "msg ok"; m.textContent = "Claimed."; }
        catch (e) { m.className = "msg err"; m.textContent = errText(e); }
      };
    });
  }
  if (!x.curve.graduated) tradePanel(x);
}

function tradePanel(x) {
  let mode = "buy", seq = 0;
  const tokenC = new ethers.Contract(x.token, window.TOKEN_ABI, rpc);
  const setMode = m => {
    mode = m;
    $("#tb").classList.toggle("sel", m === "buy"); $("#ts").classList.toggle("sel", m === "sell");
    $("#amtl").textContent = m === "buy" ? "Amount (ETH)" : `Amount (${x.symbol})`;
    $("#trade").textContent = m === "buy" ? "Buy" : "Sell";
    $("#amt").value = "";
    $("#quick").innerHTML = m === "buy"
      ? ["0.005", "0.01", "0.05", "0.1"].map(v => `<button class="btn" data-v="${v}">${v} ETH</button>`).join("")
      : ["25", "50", "100"].map(v => `<button class="btn" data-p="${v}">${v}%</button>`).join("");
    document.querySelectorAll("#quick [data-v]").forEach(b => b.onclick = () => { $("#amt").value = b.dataset.v; quote(); });
    document.querySelectorAll("#quick [data-p]").forEach(b => b.onclick = async () => {
      if (!account) return alertMsg("Connect your wallet first.");
      const bal = await tokenC.balanceOf(account);
      $("#amt").value = ethers.formatEther(bal * BigInt(b.dataset.p) / 100n); quote();
    });
    quote();
  };
  async function quote() {
    const my = ++seq, q = $("#quote");
    if (!q) return null;
    let amt; try { amt = $("#amt").value ? ethers.parseEther($("#amt").value) : 0n; } catch { q.textContent = "Bad amount"; return null; }
    if (amt === 0n) { q.innerHTML = "&nbsp;"; return null; }
    const who = account || ethers.ZeroAddress;
    try {
      if (mode === "buy") {
        const [out, used] = await padRead.quoteBuy(x.token, amt, who);
        if (my !== seq || !q.isConnected) return null;
        q.textContent = `≈ ${fmtTok(out)} ${x.symbol}` + (used < amt ? ` · uses ${fmtEth(used, 5)} ETH, rest refunded (graduates!)` : "");
        return { amt, out };
      } else {
        const out = await padRead.quoteSell(x.token, amt, who);
        if (my !== seq || !q.isConnected) return null;
        q.textContent = `≈ ${fmtEth(out, 6)} ETH`;
        return { amt, out };
      }
    } catch (e) { if (q.isConnected) q.textContent = errText(e); return null; }
  }
  $("#tb").onclick = () => setMode("buy");
  $("#ts").onclick = () => setMode("sell");
  $("#amt").oninput = quote;
  $("#trade").onclick = async () => {
    const msg = $("#msg"); msg.className = "msg"; msg.textContent = "";
    try {
      const pad = await needWallet(); if (!pad) return;
      const q = await quote(); if (!q) { msg.className = "msg err"; msg.textContent = "Enter an amount."; return; }
      const slip = BigInt(Math.round(Math.max(0.1, Number($("#slip").value) || 3) * 100));
      const min = q.out * (10000n - slip) / 10000n;
      $("#trade").disabled = true;
      msg.textContent = "Confirm in your wallet…";
      let tx;
      if (mode === "buy") {
        const est = await pad.buy.estimateGas(x.token, min, { value: q.amt });
        tx = await pad.buy(x.token, min, { value: q.amt, gasLimit: est * 15n / 10n }); // graduation creates a Uniswap pair: keep headroom
      } else {
        const est = await pad.sell.estimateGas(x.token, q.amt, min);
        tx = await pad.sell(x.token, q.amt, min, { gasLimit: est * 13n / 10n });
      }
      msg.innerHTML = `Sent. <a href="${explorer("tx", tx.hash)}" target="_blank" rel="noopener">View tx</a>`;
      await tx.wait();
      cache.at = 0;
      route();
    } catch (e) { msg.className = "msg err"; msg.textContent = errText(e); }
    finally { const b = $("#trade"); if (b) b.disabled = false; }
  };
  setMode("buy");
}

async function loadTrades(addr) {
  try {
    const topic = padIface.getEvent("Trade").topicHash;
    const logs = await getLogs({ address: C.PAD, topics: [topic, ethers.zeroPadValue(addr, 32)] });
    const trades = await Promise.all(logs.map(async l => {
      const ev = padIface.parseLog(l);
      return { isBuy: ev.args.isBuy, trader: ev.args.trader, eth: ev.args.ethAmount, tok: ev.args.tokenAmount, vEth: ev.args.vEth, vTok: ev.args.vTok, ts: await tsOf(l.blockNumber, l.blockTimestamp), hash: l.transactionHash };
    }));
    const tb = $("#trades"); if (!tb) return;
    tb.innerHTML = trades.length ? trades.slice().reverse().slice(0, 50).map(t => `<tr><td class="${t.isBuy ? "buy" : "sell"}">${t.isBuy ? "Buy" : "Sell"}</td><td><a href="${explorer("tx", t.hash)}" target="_blank" rel="noopener">${short(t.trader)}</a></td><td class="num">${fmtEth(t.eth, 5)}</td><td class="num">${fmtTok(t.tok)}</td><td class="num">${ago(t.ts)}</td></tr>`).join("") : `<tr><td colspan="5">No trades yet.</td></tr>`;
    drawChart(trades);
  } catch (e) { const tb = $("#trades"); if (tb) tb.innerHTML = `<tr><td colspan="5">${esc(errText(e))}</td></tr>`; }
}

function drawChart(trades) {
  const svg = $("#chart"); if (!svg) return;
  const start = Number(C.VIRTUAL_ETH) / 1.073e9;
  const pts = [start * 1e6, ...trades.map(t => Number(t.vEth) / Number(t.vTok) * 1e6)];
  if (pts.length < 2) { svg.innerHTML = `<text x="300" y="115" text-anchor="middle" fill="currentColor" opacity=".5">No trades yet</text>`; return; }
  const W = 600, H = 220, pad = 12;
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || max || 1;
  const xy = pts.map((v, i) => [pad + (W - 2 * pad) * i / (pts.length - 1), H - pad - (H - 2 * pad) * (v - min) / span]);
  const d = xy.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  svg.innerHTML = `<path d="${d} L ${W - pad} ${H - pad} L ${pad} ${H - pad} Z" fill="var(--chart)" opacity=".12"/><path d="${d}" fill="none" stroke="var(--chart)" stroke-width="2.5" vector-effect="non-scaling-stroke"/><text x="${W - pad}" y="18" text-anchor="end" font-size="13" fill="currentColor" opacity=".6">${max.toPrecision(3)}</text><text x="${W - pad}" y="${H - 16}" text-anchor="end" font-size="13" fill="currentColor" opacity=".6">${min.toPrecision(3)}</text>`;
}

// ---------------------------------------------------------------- router
function route() {
  renderSeq++;
  if (!C.PAD) return notDeployed();
  const h = location.hash.slice(1);
  if (h === "create") return viewCreate();
  if (h.startsWith("t-")) return viewToken(h.slice(2));
  return viewList();
}
addEventListener("hashchange", route);
if (C.PAD) { const pl = $("#padLink"); pl.href = explorer("address", C.PAD); }
route();
// reconnect silently if the wallet already authorised this site
if (window.ethereum) window.ethereum.request({ method: "eth_accounts" }).then(a => { if (a && a[0]) { account = ethers.getAddress(a[0]); $("#connect").textContent = short(account); new ethers.BrowserProvider(window.ethereum).getSigner().then(s => { signer = s; checkNet(); route(); }); } }).catch(() => {});
