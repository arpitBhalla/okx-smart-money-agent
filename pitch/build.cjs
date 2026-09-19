const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const fa = require("react-icons/fa");
const path = require("path");

const REPO = "/Users/arpit/Desktop/datadash/okx-smart-money-agent";
const OUT = path.join(REPO, "pitch", "Datadash-Smart-Money.pptx");
const LOGO = path.join(REPO, "listing", "avatar.png");

// Datadash palette from the logo's grid, on a trading-terminal ink.
const C = {
  bg: "0E0C1F",
  card: "1A1638",
  card2: "241E4D",
  edge: "322B6B",
  p1: "4E3DC9",
  p2: "6247EA",
  p3: "7653F6",
  p4: "907AF9",
  p5: "A79CF7",
  p6: "CECAFF",
  white: "FFFFFF",
  soft: "C9C4EE",
  muted: "8E88BF",
  green: "2EE6A6",
  red: "FF6B7A",
};
const SHADES = [C.p1, C.p2, C.p3, C.p4, C.p5, C.p6];
const F = "Arial";
const MONO = "Courier New";
const UNI = "Arial Unicode MS"; // for 【】 and ✓, which Courier New lacks

async function icon(Comp, color = C.white) {
  const svg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Comp, { color: `#${color}`, size: "256" }),
  );
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}

const T = (slide, text, o) =>
  slide.addText(text, { fontFace: F, margin: 0, isTextBox: true, color: C.white, ...o });

// The logo motif: a field of squares, darker toward the top-left, some faded like data points.
function pixelField(slide, x0, y0, cols, rows, size, gap, seed = 7) {
  let r = seed;
  const rand = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const shade = SHADES[Math.min(5, Math.floor(((col + row) / (cols + rows - 2)) * 6))];
      const fade = rand();
      if (fade < 0.12) continue;
      slide.addShape("rect", {
        x: x0 + col * (size + gap), y: y0 + row * (size + gap), w: size, h: size,
        fill: { color: fade < 0.45 ? "2B2466" : shade }, line: { color: fade < 0.45 ? "2B2466" : shade },
      });
    }
}

// Section label: a 2x2 pixel mark, the number and the name.
function label(slide, num, name) {
  const s = 0.1, g = 0.03, x = 0.8, y = 0.62;
  [[0, 0, C.p2], [1, 0, C.p3], [0, 1, C.p4], [1, 1, C.p6]].forEach(([c, r, col]) =>
    slide.addShape("rect", { x: x + c * (s + g), y: y + r * (s + g), w: s, h: s, fill: { color: col }, line: { color: col } }));
  T(slide, `${num}  ${name}`, { x: 1.15, y: 0.56, w: 8, h: 0.35, fontSize: 12, bold: true, color: C.p5, charSpacing: 4 });
}

function headline(slide, text, o = {}) {
  T(slide, text, { x: 0.8, y: 1.05, w: 11.7, h: 1.3, fontSize: 36, bold: true, valign: "top", ...o });
}

function tile(slide, x, y, s, fill, text) {
  slide.addShape("roundRect", { x, y, w: s, h: s, fill: { color: fill }, line: { color: fill }, rectRadius: 0.1 });
  if (text) T(slide, text, { x, y, w: s, h: s, fontSize: Math.round(s * 22), bold: true, align: "center", valign: "middle" });
}

function card(slide, x, y, w, h, o = {}) {
  slide.addShape("roundRect", {
    x, y, w, h, rectRadius: 0.14, fill: { color: o.fill || C.card },
    line: { color: o.line || o.fill || C.card, width: o.lineWidth || 1 },
  });
}

async function main() {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
  pres.title = "Datadash Smart Money on OKX.AI";
  const slide = () => {
    const s = pres.addSlide();
    s.background = { color: C.bg };
    return s;
  };

  // 1. Title
  {
    const s = slide();
    pixelField(s, 8.35, -0.35, 6, 9, 0.78, 0.07, 11);
    s.addImage({ path: LOGO, x: 0.8, y: 0.7, w: 0.55, h: 0.55 });
    T(s, "Datadash", { x: 1.5, y: 0.7, w: 4, h: 0.55, fontSize: 22, bold: true, valign: "middle" });
    T(s, "Follow Polymarket's best traders from any OKX agent.", {
      x: 0.8, y: 1.95, w: 7.3, h: 3.2, fontSize: 50, bold: true, valign: "top",
    });
    T(s, "Smart-money signals on OKX.AI: Datadash finds the trades, OKX runs the subscription, the payment and the execution.", {
      x: 0.8, y: 5.05, w: 6.9, h: 0.9, fontSize: 18, color: C.soft, valign: "top",
    });
    s.addShape("roundRect", { x: 0.8, y: 6.3, w: 4.1, h: 0.5, rectRadius: 0.25, fill: { color: C.bg }, line: { color: C.p3, width: 1.25 } });
    T(s, "OKX Dev Day 2026  ·  Build a Company", { x: 0.8, y: 6.3, w: 4.1, h: 0.5, fontSize: 14, bold: true, color: C.p6, align: "center", valign: "middle" });
    s.addNotes("Datadash tracks every Polymarket wallet. This agent turns what the most profitable ones do into signals any OKX agent can subscribe to and copy.");
  }

  // 2. Problem
  {
    const s = slide();
    label(s, "01", "THE PROBLEM");
    headline(s, "Polymarket's best traders are public.\nActing on them isn't.");
    const cols = [
      ["500", "top wallets to watch, around the clock, across every market"],
      ["1", "whale can be wrong, hedged elsewhere, or already on the way out"],
      ["3¢", "of drift can erase a copied trade's edge. We stop chasing there"],
    ];
    cols.forEach(([big, text], i) => {
      const x = 0.8 + i * 4.05;
      T(s, big, { x, y: 3.0, w: 3.7, h: 1.6, fontSize: 96, bold: true, color: i === 0 ? C.p4 : i === 1 ? C.p5 : C.p6 });
      T(s, text, { x, y: 4.75, w: 3.5, h: 1.3, fontSize: 19, color: C.soft, valign: "top" });
    });
    card(s, 0.8, 6.15, 11.75, 0.7, { fill: C.card });
    T(s, "Datadash already scores every Polymarket wallet. This agent turns that into signals any OKX agent can act on.", { x: 1.1, y: 6.15, w: 11.3, h: 0.7, fontSize: 16, color: C.white, valign: "middle" });
    s.addNotes("Every trade is on-chain, so the information is free. What's missing is attention, judgment about which trades matter, and speed.");
  }

  // 3. The idea
  {
    const s = slide();
    label(s, "02", "THE IDEA");
    headline(s, "One trader bets big. The smart money agrees.\nYou get the signal.");
    const blocks = [
      [0.8, fa.FaBolt, C.p2, "TRIGGER", "An unusually big bet", "A top-500 trader holds 3x+ their usual size, with a high Datadash score. Gives the moment, the price and the size."],
      [5.15, fa.FaUsers, C.p4, "CONFIRMATION", "Smart money agrees", "60%+ of the money top-500 wallets hold on that market sits on the same side, across 3+ wallets."],
    ];
    for (const [x, ic, fill, tag, head, body] of blocks) {
      card(s, x, 2.85, 3.95, 3.75);
      tile(s, x + 0.35, 3.2, 0.8, fill);
      s.addImage({ data: await icon(ic), x: x + 0.55, y: 3.4, w: 0.4, h: 0.4 });
      T(s, tag, { x: x + 0.35, y: 4.2, w: 3.3, h: 0.3, fontSize: 12, bold: true, color: C.p5, charSpacing: 3 });
      T(s, head, { x: x + 0.35, y: 4.52, w: 3.3, h: 0.5, fontSize: 22, bold: true });
      T(s, body, { x: x + 0.35, y: 5.1, w: 3.3, h: 1.4, fontSize: 15, color: C.soft, valign: "top" });
    }
    T(s, "+", { x: 4.75, y: 4.2, w: 0.4, h: 0.8, fontSize: 40, bold: true, color: C.p4, align: "center", valign: "middle" });
    T(s, "=", { x: 9.1, y: 4.2, w: 0.4, h: 0.8, fontSize: 40, bold: true, color: C.p4, align: "center", valign: "middle" });
    card(s, 9.5, 2.85, 3.05, 3.75, { fill: C.card2, line: C.green, lineWidth: 2 });
    s.addImage({ data: await icon(fa.FaSignal, C.green), x: 9.85, y: 3.25, w: 0.6, h: 0.6 });
    T(s, "SIGNAL", { x: 9.85, y: 4.2, w: 2.4, h: 0.3, fontSize: 12, bold: true, color: C.green, charSpacing: 3 });
    T(s, "A limit order any OKX agent can copy", { x: 9.85, y: 4.52, w: 2.45, h: 1.1, fontSize: 22, bold: true, valign: "top" });
    T(s, "Valid for 2 hours", { x: 9.85, y: 5.75, w: 2.4, h: 0.4, fontSize: 15, color: C.soft });
    s.addNotes("Trigger: Datadash signalScore, per trader and position. Confirmation: Datadash globalSmartMoney over top-500 wallets only. Consensus alone repeats the same markets for weeks with no entry price; one trader alone can be wrong.");
  }

  // 4. The product
  {
    const s = slide();
    label(s, "03", "THE PRODUCT");
    headline(s, "What lands in the subscriber's agent");
    card(s, 0.8, 2.2, 7.7, 4.4, { fill: C.card, line: C.edge });
    s.addShape("rect", { x: 0.81, y: 2.21, w: 7.68, h: 0.02, fill: { color: C.card }, line: { color: C.card } });
    ["FF5F57", "FEBC2E", "28C840"].forEach((col, i) =>
      s.addShape("ellipse", { x: 1.1 + i * 0.28, y: 2.45, w: 0.16, h: 0.16, fill: { color: col }, line: { color: col } }));
    T(s, "subscriber's agent  ·  okx-ai", { x: 2.05, y: 2.36, w: 5, h: 0.34, fontSize: 12, color: C.muted, fontFace: MONO });
    s.addShape("line", { x: 0.8, y: 2.85, w: 7.7, h: 0, line: { color: C.edge, width: 1 } });
    s.addText([
      { text: "OKX.AI · Polymarket Smart Money Signals · new signal", options: { color: C.muted, fontFace: MONO, fontSize: 15, breakLine: true } },
      { text: " ", options: { fontSize: 8, breakLine: true } },
      { text: "【", options: { color: C.green, fontFace: UNI, fontSize: 19 } },
      { text: "Prediction", options: { color: C.green, fontFace: MONO, fontSize: 19, bold: true } },
      { text: "】", options: { color: C.green, fontFace: UNI, fontSize: 19 } },
      { text: '"Will Benjamin Netanyahu be the next Prime Minister of Israel?" | NO | Limit | Order Price 0.73 | Position 2% | Settlement 2026-10-27 | Valid for 2h', options: { color: C.white, fontFace: MONO, fontSize: 19, breakLine: true } },
      { text: " ", options: { fontSize: 8, breakLine: true } },
      { text: "copy-trading on · $5 per order", options: { color: C.muted, fontFace: MONO, fontSize: 15, breakLine: true } },
      { text: "→ ", options: { color: C.p5, fontFace: UNI, fontSize: 16 } },
      { text: "limit order: NO at 0.73, $5, via the Polymarket plugin", options: { color: C.p5, fontFace: MONO, fontSize: 16 } },
    ], { x: 1.15, y: 3.1, w: 7.05, h: 3.5, valign: "top", margin: 0, isTextBox: true, paraSpaceAfter: 4 });

    T(s, "WHY IT FIRED", { x: 9.1, y: 2.2, w: 3.5, h: 0.3, fontSize: 12, bold: true, color: C.p5, charSpacing: 3 });
    const why = [["#120", "trader rank, all-time PnL", C.white], ["3.9x", "their usual bet size", C.white], ["95%", "of top-500 money on NO, 16 wallets", C.white], ["+37%", "payout if right", C.green]];
    why.forEach(([big, cap, col], i) => {
      const y = 2.65 + i * 1.06;
      T(s, big, { x: 9.1, y, w: 1.95, h: 0.8, fontSize: 38, bold: true, color: col, valign: "middle" });
      T(s, cap, { x: 11.05, y, w: 1.75, h: 0.8, fontSize: 14, color: C.soft, valign: "middle" });
    });
    s.addNotes("A real signal from pnpm preview on 2026-09-23. The last line shows what the subscriber's agent does next when copy-trading is on; in the demo we run it live.");
  }

  // 5. How it works
  {
    const s = slide();
    label(s, "04", "HOW IT WORKS");
    headline(s, "Datadash finds the trades.\nOKX runs everything else.");
    const nodes = [
      [fa.FaDatabase, "Datadash", "Every Polymarket wallet, scored"],
      [fa.FaSyncAlt, "Delivery program", "Checks every 2 minutes"],
      [fa.FaFileContract, "OKX.AI", "Subscription, fee and escrow on X Layer"],
      [fa.FaRobot, "Subscriber's agent", "Copies with the amount they chose"],
      [fa.FaChartLine, "Polymarket", "Limit order from their own wallet"],
    ];
    const fills = [C.p1, C.p2, C.p3, C.p4, C.p5];
    for (let i = 0; i < nodes.length; i++) {
      const x = 0.8 + i * 2.45;
      tile(s, x, 2.75, 1.2, fills[i]);
      s.addImage({ data: await icon(nodes[i][0]), x: x + 0.35, y: 3.1, w: 0.5, h: 0.5 });
      if (i < nodes.length - 1)
        s.addShape("line", { x: x + 1.35, y: 3.35, w: 0.95, h: 0, line: { color: C.p4, width: 2, endArrowType: "triangle" } });
      T(s, nodes[i][1], { x, y: 4.15, w: 2.2, h: 0.4, fontSize: 17, bold: true });
      T(s, nodes[i][2], { x, y: 4.6, w: 2.1, h: 0.8, fontSize: 14, color: C.soft, valign: "top" });
    }
    card(s, 0.8, 5.65, 4.55, 1.05, { fill: C.card, line: C.p1 });
    T(s, "DATADASH", { x: 1.1, y: 5.8, w: 4, h: 0.3, fontSize: 12, bold: true, color: C.p5, charSpacing: 3 });
    T(s, "Which trades are worth following", { x: 1.1, y: 6.12, w: 4.1, h: 0.4, fontSize: 15, color: C.white });
    card(s, 5.7, 5.65, 6.85, 1.05, { fill: C.card, line: C.p4 });
    T(s, "OKX RAILS", { x: 6.0, y: 5.8, w: 4, h: 0.3, fontSize: 12, bold: true, color: C.p5, charSpacing: 3 });
    T(s, "Agentic Wallet · OKX.AI subscriptions · Polymarket plugin", { x: 6.0, y: 6.12, w: 6.4, h: 0.4, fontSize: 15, color: C.white });
    s.addNotes("The resident program calls onchainos agent subscribe-active and agent deliver. Datadash never holds funds or places trades; copy-trading is off unless each subscriber turns it on.");
  }

  // 6. Rules
  {
    const s = slide();
    label(s, "05", "THE RULES");
    headline(s, "Nine filters. Most big bets never make it.");
    const rules = [
      ["Top 500", "trader by all-time PnL"], ["80+", "Datadash signal score"], ["3x+", "the trader's usual bet"], ["$5K+", "of their money behind it"],
      ["10–85¢", "price: about +16% or more if right"], ["+3¢ / −10¢", "price vs. their entry"], ["7 days", "since a top trader last bought"], ["1–120", "days until the market ends"], ["60%", "of top-500 money on the same side, 3+ wallets"],
    ];
    rules.forEach(([big, cap], i) => {
      const x = 0.8 + (i % 3) * 3.97, y = 2.15 + Math.floor(i / 3) * 1.25;
      const hero = i === 8;
      card(s, x, y, 3.8, 1.1, { fill: hero ? C.p2 : C.card });
      T(s, big, { x: x + 0.3, y, w: 2.0, h: 1.1, fontSize: 24, bold: true, color: hero ? C.white : C.p4, valign: "middle" });
      T(s, cap, { x: x + 2.35, y, w: 1.35, h: 1.1, fontSize: 13, color: hero ? C.p6 : C.soft, valign: "middle" });
    });
    const caps = ["3 new signals per round, strongest first", "1 live signal per event", "1 live signal per trader"];
    caps.forEach((t, i) => {
      const x = 0.8 + i * 3.97;
      s.addShape("roundRect", { x, y: 6.1, w: 3.8, h: 0.55, rectRadius: 0.27, fill: { color: C.bg }, line: { color: C.edge, width: 1.25 } });
      T(s, t, { x, y: 6.1, w: 3.8, h: 0.55, fontSize: 14, color: C.soft, align: "center", valign: "middle" });
    });
    s.addNotes("Several traders on one outcome become one signal; markets where top traders hold both sides are skipped. Every threshold is a setting.");
  }

  // 7. Backtest
  {
    const s = slide();
    label(s, "06", "THE EVIDENCE");
    headline(s, "180 days replayed: a thin edge, mostly sports.");
    T(s, "+$16.7K", { x: 0.8, y: 2.3, w: 6, h: 1.4, fontSize: 88, bold: true, color: C.green });
    T(s, "backtest, not a promise: 3,782 settled signals at $100 each, March to September 2026", { x: 0.8, y: 3.75, w: 5.9, h: 0.7, fontSize: 17, color: C.soft, valign: "top" });
    [["64.9%", "won"], ["+4.4%", "per signal"], ["$2.3K", "max drawdown"]].forEach(([big, cap], i) => {
      const x = 0.8 + i * 2.0;
      T(s, big, { x, y: 4.65, w: 1.9, h: 0.65, fontSize: 30, bold: true });
      T(s, cap, { x, y: 5.3, w: 1.9, h: 0.4, fontSize: 14, color: C.soft });
    });

    // Bars drawn as shapes so every app renders them.
    const bx = 7.35, bw = 5.2, top = 2.35, zeroY = 5.1, perPt = 0.3;
    card(s, bx - 0.25, top - 0.15, bw + 0.5, 3.75);
    T(s, "Average return by time to settle", { x: bx, y: top, w: bw, h: 0.35, fontSize: 14, bold: true, color: C.soft });
    const bars = [["<2h", 6.3], ["2–6h", -0.3], ["6–24h", 1.2], ["1–7d", 2.1], [">7d", 3.1]];
    s.addShape("line", { x: bx, y: zeroY, w: bw, h: 0, line: { color: C.edge, width: 1 } });
    bars.forEach(([name, v], i) => {
      const x = bx + 0.2 + i * 1.0, w = 0.6, h = Math.max(0.04, Math.abs(v) * perPt);
      const col = v < 0 ? C.red : i === 0 ? C.green : C.p3;
      s.addShape("rect", { x, y: v >= 0 ? zeroY - h : zeroY, w, h, fill: { color: col }, line: { color: col } });
      T(s, `${v > 0 ? "+" : ""}${v.toFixed(1)}%`, { x: x - 0.2, y: v >= 0 ? zeroY - h - 0.35 : zeroY + 0.08, w: w + 0.4, h: 0.3, fontSize: 13, bold: true, align: "center", color: v < 0 ? C.red : C.white });
      T(s, name, { x: x - 0.2, y: 5.6, w: w + 0.4, h: 0.3, fontSize: 13, align: "center", color: C.soft });
    });
    T(s, "Honest limits: wallet ranks are today's (look-ahead bias) · 93% sports, most settling within hours · the score and smart-money check can't be replayed · signals taking a day or more: +2.4% ± 2.9%. The live track record is the real test.", {
      x: 0.8, y: 6.15, w: 11.75, h: 0.8, fontSize: 14, color: C.soft, valign: "top",
    });
    s.addNotes("pnpm backtest. As delivered with caps: 3,782 resolved, 64.9% hit rate, +4.4% ± 1.4% per signal, max drawdown $2,327. Before caps: 6,264 resolved, +2.1% ± 1.1%. Entries at 0.10 to 0.30 lost 20.8%.");
  }

  // 8. Trust
  {
    const s = slide();
    label(s, "07", "TRUST");
    headline(s, "Each rule answers something we saw.");
    const rows = [
      ["One wallet drove 4 of 13 signals", "One live signal per event and per trader"],
      ["A lone whale can be wrong or hedged", "Smart-money consensus must agree"],
      ["Some traders were already losing badly", "Skip prices 10¢+ below their entry"],
      ["Old holdings and sells looked like news", "A top trader must have bought within 7 days"],
      ["Subscribers can't verify claims", "Every signal sent is scored once it settles"],
    ];
    T(s, "WE SAW", { x: 0.8, y: 2.15, w: 4, h: 0.3, fontSize: 12, bold: true, color: C.muted, charSpacing: 3 });
    T(s, "SO THE AGENT", { x: 6.95, y: 2.15, w: 4, h: 0.3, fontSize: 12, bold: true, color: C.p5, charSpacing: 3 });
    for (let i = 0; i < rows.length; i++) {
      const y = 2.6 + i * 0.86;
      card(s, 0.8, y, 11.75, 0.72);
      T(s, rows[i][0], { x: 1.1, y, w: 5.3, h: 0.72, fontSize: 17, color: C.soft, valign: "middle" });
      s.addImage({ data: await icon(fa.FaArrowRight, C.p4), x: 6.35, y: y + 0.24, w: 0.26, h: 0.24 });
      T(s, rows[i][1], { x: 6.95, y, w: 5.4, h: 0.72, fontSize: 17, bold: true, valign: "middle" });
    }
    s.addNotes("Plus: a health file after every round, and webhook alerts when rounds fail or a subscription waits too long for acceptance.");
  }

  // 9. Business model
  {
    const s = slide();
    label(s, "08", "BUSINESS MODEL");
    headline(s, "Free data pulls agents in. Signals pay.");
    const tiers = [
      ["FREE", "0", "via A2MCP", ["Free Datadash tools any agent can call", "smart-money-edge, market-read", "Try the data before paying"], false, ""],
      ["STANDARD", "5 USDT", "a month, 3-day trial", ["Scanned every 2 minutes, signals as they qualify", "Copy-trading through your own agent", "Track record of every signal"], true, "THIS AGENT"],
      ["PRO", "25 USDT", "a month", ["30-second scans, no cap", "Custom trader lists", "Category filters"], false, "PROPOSED"],
    ];
    tiers.forEach(([name, price, per, items, hero, status], i) => {
      const x = 0.8 + i * 3.97, y = 2.2;
      card(s, x, y, 3.75, 4.6, { fill: hero ? C.p2 : C.card, line: hero ? C.p2 : C.card });
      T(s, name, { x: x + 0.35, y: y + 0.35, w: 2, h: 0.3, fontSize: 13, bold: true, color: hero ? C.p6 : C.p5, charSpacing: 3 });
      if (status) {
        s.addShape("roundRect", { x: x + 2.05, y: y + 0.32, w: 1.4, h: 0.34, rectRadius: 0.17, fill: { color: hero ? C.white : C.bg }, line: { color: hero ? C.white : C.muted, width: 1 } });
        T(s, status, { x: x + 2.05, y: y + 0.32, w: 1.4, h: 0.34, fontSize: 10, bold: true, align: "center", valign: "middle", color: hero ? C.p2 : C.muted, charSpacing: 2 });
      }
      T(s, price, { x: x + 0.35, y: y + 0.85, w: 3.1, h: 0.9, fontSize: 44, bold: true });
      T(s, per, { x: x + 0.35, y: y + 1.75, w: 3.1, h: 0.35, fontSize: 15, color: hero ? C.p6 : C.soft });
      T(s, items.map((t, j) => ({ text: t, options: { bullet: true, breakLine: j < items.length - 1 } })), {
        x: x + 0.35, y: y + 2.45, w: 3.1, h: 1.9, fontSize: 15, color: C.white, paraSpaceAfter: 10, valign: "top",
      });
    });
    s.addNotes("OKX blocks a price of 0 on subscriptions, so the free tier lives on A2MCP. Pro becomes a second service on the same identity once Standard has a track record.");
  }

  // 10. Demo
  {
    const s = slide();
    label(s, "09", "DEMO");
    headline(s, "From search to a limit order in 3 minutes.");
    const steps = [
      ["Find", '"Find a Polymarket smart money signal service on OKX.AI"'],
      ["Subscribe", "Free trial, copy-trading on, $5 per order. Escrow on X Layer"],
      ["Signal", "Provider logs: new signal, delivered. It lands on the buyer's screen"],
      ["Copy", "The buyer's agent places the $5 limit order"],
      ["Verify", "The transaction on Polygonscan, the position on Polymarket"],
    ];
    s.addShape("line", { x: 1.4, y: 3.0, w: 10.0, h: 0, line: { color: C.edge, width: 2 } });
    steps.forEach(([name, text], i) => {
      const x = 0.8 + i * 2.45;
      tile(s, x, 2.4, 1.2, SHADES[i], String(i + 1));
      T(s, name, { x, y: 3.85, w: 2.2, h: 0.45, fontSize: 20, bold: true });
      T(s, text, { x, y: 4.35, w: 2.15, h: 1.5, fontSize: 15, color: C.soft, valign: "top" });
    });
    card(s, 0.8, 6.0, 11.75, 0.75, { fill: C.card });
    T(s, "Order didn't fill? By design: the limit is capped at 3¢ over what the top traders paid, so subscribers never chase.", {
      x: 1.1, y: 6.0, w: 11.3, h: 0.75, fontSize: 15, color: C.soft, valign: "middle",
    });
    s.addNotes("Two screens: the buyer (Claude Code with Onchain OS and a funded Agentic Wallet) and the provider server running pnpm start. Full script in DEMO.md.");
  }

  // 11. Roadmap
  {
    const s = slide();
    label(s, "10", "WHAT'S NEXT");
    headline(s, "Where this grows.");
    const cols = [
      ["NOW", C.p2, ["Ready to list on OKX.AI (review pending)", "Trigger + smart-money confirmation", "Backtest done; track record starts with the first signal"]],
      ["NEXT", C.p4, ["Pro tier on the same identity", "Category filters, starting with in-play sports", "Thresholds tuned on the live record"]],
      ["LATER", C.p6, ["Every prediction market Datadash indexes", "License the Datadash score as an API", "Signals for other agent marketplaces"]],
    ];
    cols.forEach(([name, col, items], i) => {
      const x = 0.8 + i * 3.97;
      s.addShape("rect", { x, y: 2.3, w: 0.28, h: 0.28, fill: { color: col }, line: { color: col } });
      T(s, name, { x: x + 0.45, y: 2.22, w: 3, h: 0.45, fontSize: 16, bold: true, color: col, charSpacing: 3, valign: "middle" });
      items.forEach((t, j) => {
        card(s, x, 2.95 + j * 1.2, 3.75, 1.0);
        T(s, t, { x: x + 0.3, y: 2.95 + j * 1.2, w: 3.2, h: 1.0, fontSize: 16, valign: "middle" });
      });
    });
    s.addNotes("The backtest showed most historical signals were sports bets settling within hours; a category filter is the first product change to test.");
  }

  // 12. Close
  {
    const s = slide();
    pixelField(s, -1.0, 4.4, 17, 4, 0.78, 0.07, 3);
    s.addImage({ path: LOGO, x: 0.8, y: 0.7, w: 0.55, h: 0.55 });
    T(s, "Datadash", { x: 1.5, y: 0.7, w: 4, h: 0.55, fontSize: 22, bold: true, valign: "middle" });
    T(s, "Datadash finds the trades.\nOKX runs everything else.", { x: 0.8, y: 1.6, w: 11.5, h: 2.0, fontSize: 48, bold: true, valign: "top" });
    T(s, "Follow Polymarket's best traders from any OKX agent.", { x: 0.8, y: 3.6, w: 11.5, h: 0.5, fontSize: 20, color: C.p6 });
    s.addNotes("Signals are information, not financial advice. Copy-trading is off unless each subscriber turns it on. Thank you.");
  }

  await pres.writeFile({ fileName: OUT });
  console.log("wrote", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
