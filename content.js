// Curling Club Bracket Viewer - Content Script
// Runs on curlingseattle.org/bonspiels?disp=team pages

(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  if (params.get('disp') !== 'team' || !params.has('teamid')) return;

  // ── Helpers ──────────────────────────────────────────────────────────────

  const DAY_ORDER = { monday:0, tuesday:1, wednesday:2, thursday:3, friday:4, saturday:5, sunday:6 };

  function parseDrawTime(timeStr) {
    if (!timeStr) return 99999;
    const s = timeStr.toLowerCase();
    let day = 5;
    for (const [k, v] of Object.entries(DAY_ORDER)) { if (s.includes(k)) { day = v; break; } }
    const m = s.match(/(\d+):(\d+)\s*(am|pm)/);
    if (!m) return day * 10000;
    let h = parseInt(m[1]), min = parseInt(m[2]);
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return day * 10000 + h * 100 + min;
  }

  function getTier(gameId) {
    const c = (gameId || '').replace(/\d/g, '').toUpperCase().charAt(0);
    return ['A','B','C','D','E'].includes(c) ? c : 'X';
  }

  function escXml(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── DOM Parsing ───────────────────────────────────────────────────────────

  /**
   * Parse a game <div> or root <span> into a node object.
   * The div looks like:
   *   <div><em>Win: </em> Saturday 1:00 am - Game A32 - vs. <span class="forwardref">Winner&nbsp;A19</span></div>
   */
  function parseGameText(el) {
    const text = el.innerText || el.textContent || '';
    const gameMatch = text.match(/Game\s+([A-Z]\d+)/i);
    if (!gameMatch) return null;

    const gameId = gameMatch[1].toUpperCase();
    const timeMatch = text.match(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d+:\d+\s*(?:am|pm)/i);
    const vsIdx = text.indexOf('vs.');
    let opponent = null;
    if (vsIdx !== -1) {
      // Get text after "vs." — use the forwardref span if present, else plain text
      const forwardRef = el.querySelector('.forwardref');
      const teamLink = el.querySelector('a.team');
      if (teamLink) {
        opponent = teamLink.textContent.trim();
        // Also get the title as full roster hint
      } else if (forwardRef) {
        opponent = forwardRef.textContent.replace(/\u00a0/g, ' ').trim();
      } else {
        opponent = text.substring(vsIdx + 3).trim().split('\n')[0].trim();
      }
    }

    // Check for score — look for "W X-Y" or "L X-Y" pattern, or just "X-Y"
    const scoreMatch = text.match(/\b(\d+)\s*[-–]\s*(\d+)\b/);
    const won = /\bW\b/.test(text) && scoreMatch ? true
              : /\bL\b/.test(text) && scoreMatch ? false
              : null;

    return {
      gameId,
      time: timeMatch ? timeMatch[0].trim() : null,
      timeVal: timeMatch ? parseDrawTime(timeMatch[0]) : 99999,
      opponent,
      score: scoreMatch ? `${scoreMatch[1]}-${scoreMatch[2]}` : null,
      won,
      tier: getTier(gameId),
      winChild: null,
      loseChild: null,
    };
  }

  /**
   * Recursively parse a connector container (leftconnect / noconnect / text-indent div).
   * Children are alternating: game-div, [connector-div], game-div, [connector-div], ...
   * Returns array of {outcome:'win'|'lose', node} objects.
   */
  function parseContainer(containerEl) {
    const results = [];
    const kids = Array.from(containerEl.children);
    let i = 0;
    while (i < kids.length) {
      const kid = kids[i];
      const em = kid.querySelector(':scope > em');
      if (em) {
        const emText = em.textContent.trim().toLowerCase();
        const outcome = emText.startsWith('win') ? 'win' : emText.startsWith('los') ? 'lose' : 'unknown';
        const node = parseGameText(kid);
        if (node) {
          // Check if next sibling is a connector (children of this node)
          const next = kids[i + 1];
          if (next && (next.classList.contains('leftconnect') || next.classList.contains('noconnect'))) {
            const children = parseContainer(next);
            for (const c of children) {
              if (c.outcome === 'win') node.winChild = c.node;
              else if (c.outcome === 'lose') node.loseChild = c.node;
            }
            i += 2;
          } else {
            i += 1;
          }
          results.push({ outcome, node });
        } else {
          i += 1;
        }
      } else {
        i += 1;
      }
    }
    return results;
  }

  /**
   * Find and parse the entire game tree from the page.
   * Returns the root node.
   */
  function parseTree() {
    // Root game is in a <span> inside a margin-top div (no <em>)
    let rootSpan = null;
    for (const el of document.querySelectorAll('div[style*="margin-top"] span')) {
      if (/Game\s+[A-Z]\d+/i.test(el.textContent)) { rootSpan = el; break; }
    }
    if (!rootSpan) return null;

    const rootNode = parseGameText(rootSpan.closest('div[style*="margin-top"]') || rootSpan);
    if (!rootNode) return null;

    // The connector container is the next sibling DIV after the root game div.
    // There may be a <style> tag in between — skip non-div siblings.
    const rootDiv = rootSpan.closest('div[style*="margin-top"]');
    let connector = rootDiv ? rootDiv.nextElementSibling : null;
    while (connector && connector.tagName !== 'DIV') {
      connector = connector.nextElementSibling;
    }

    if (connector) {
      const children = parseContainer(connector);
      for (const c of children) {
        if (c.outcome === 'win') rootNode.winChild = c.node;
        else if (c.outcome === 'lose') rootNode.loseChild = c.node;
      }
    }

    return rootNode;
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  const NODE_W = 150;
  const NODE_H = 68;
  const COL_GAP = 20;    // horizontal gap between sibling branches
  const TIME_AXIS_W = 90; // left margin reserved for the time axis

  /** Count the number of leaf nodes in a subtree. */
  function leafCount(node) {
    if (!node) return 0;
    const wc = leafCount(node.winChild);
    const lc = leafCount(node.loseChild);
    return (wc + lc) || 1;
  }

  /** Convert a timeVal (day*10000 + h*100 + m) to total minutes since Monday midnight. */
  function timeValToMinutes(tv) {
    if (!tv || tv >= 99999) return null;
    const day = Math.floor(tv / 10000);
    const h   = Math.floor((tv % 10000) / 100);
    const m   = tv % 100;
    return day * 1440 + h * 60 + m;
  }

  /**
   * Build a Map<timeVal → pixelY> so that:
   *   • Y positions are proportional to real time (TARGET_HEIGHT covers the full span)
   *   • Adjacent draw slots are pushed apart to at least MIN_GAP pixels so nodes never overlap
   */
  function buildTimeYMap(root) {
    const allTVs = new Set();
    (function collect(n) {
      if (!n) return;
      allTVs.add(n.timeVal);
      collect(n.winChild);
      collect(n.loseChild);
    })(root);

    const sorted = Array.from(allTVs)
      .filter(tv => tv < 99999)
      .sort((a, b) => a - b);

    if (sorted.length === 0) return new Map();
    if (sorted.length === 1) return new Map([[sorted[0], 10]]);

    const TARGET_HEIGHT = 1000;  // proportional total height before push-apart
    const MIN_GAP = NODE_H + 50; // minimum pixels between consecutive draw slots

    const mins = sorted.map(timeValToMinutes);
    const span = mins[mins.length - 1] - mins[0];
    const scale = TARGET_HEIGHT / span;

    // First pass: proportional Y
    const propY = mins.map(m => (m - mins[0]) * scale);

    // Second pass: push apart any slots that are too close
    const finalY = [propY[0]];
    for (let i = 1; i < sorted.length; i++) {
      finalY.push(Math.max(propY[i], finalY[i - 1] + MIN_GAP));
    }

    const map = new Map();
    for (let i = 0; i < sorted.length; i++) map.set(sorted[i], finalY[i]);
    return map;
  }

  /** Compute horizontal (X) slot positions (0-based float) via subtree centering. */
  function assignRows(node, startRow, rowMap) {
    if (!node) return startRow;
    const wLeaves = leafCount(node.winChild);

    let winCenter = startRow;
    let loseCenter = startRow;

    if (node.winChild && node.loseChild) {
      winCenter  = assignRows(node.winChild,  startRow,           rowMap);
      loseCenter = assignRows(node.loseChild, startRow + wLeaves, rowMap);
    } else if (node.winChild) {
      winCenter = assignRows(node.winChild, startRow, rowMap);
      loseCenter = startRow;
    } else if (node.loseChild) {
      loseCenter = assignRows(node.loseChild, startRow, rowMap);
      winCenter = startRow;
    }

    const myRow = (node.winChild || node.loseChild)
      ? (winCenter + loseCenter) / 2
      : startRow;

    rowMap.set(node, myRow);
    return myRow;
  }

  function layout(root) {
    const timeYMap = buildTimeYMap(root);  // timeVal → Y pixel
    const colMap   = new Map();
    assignRows(root, 0, colMap);           // node → X slot (0-based float)

    const totalLeaves = leafCount(root);
    const colW = NODE_W + COL_GAP;

    const maxY = Math.max(...timeYMap.values());
    const svgW = TIME_AXIS_W + totalLeaves * colW + COL_GAP;
    const svgH = maxY + NODE_H + 20;

    const pixMap = new Map();
    for (const [node, col] of colMap) {
      const y = timeYMap.get(node.timeVal) ?? 10;
      pixMap.set(node, {
        x: TIME_AXIS_W + col * colW + COL_GAP / 2,
        y,
      });
    }

    return { pixMap, timeYMap, svgW, svgH };
  }

  // ── SVG Builder ───────────────────────────────────────────────────────────

  /**
   * State of a node:
   *   'done-win'  — played and won
   *   'done-lose' — played and lost
   *   'next'      — the immediate next unplayed game on a path from root
   *   'potential' — future possible game
   */
  function markStates(root) {
    const stateMap = new Map();
    // Walk the tree; once we hit a node with no score we mark it 'next' (first time only),
    // then everything beyond is 'potential'.
    let nextAssigned = false;

    function walk(node) {
      if (!node) return;
      if (node.score !== null || node.won !== null) {
        stateMap.set(node, node.won ? 'done-win' : 'done-lose');
      } else if (!nextAssigned) {
        stateMap.set(node, 'next');
        nextAssigned = true;
      } else {
        stateMap.set(node, 'potential');
      }
      walk(node.winChild);
      walk(node.loseChild);
    }
    walk(root);
    return stateMap;
  }

  function buildSVG(root) {
    const { pixMap, timeYMap, svgW, svgH } = layout(root);
    const stateMap = markStates(root);

    // Sorted timeVals for interpolation
    const sortedTVs = Array.from(timeYMap.keys()).sort((a, b) => a - b);

    /**
     * Return the pixel Y for any timeVal, interpolating between known draw slots.
     * Interpolates between the bottom of the previous node and the top of the next.
     */
    function yForTime(tv) {
      if (timeYMap.has(tv)) return timeYMap.get(tv);
      const targetMins = timeValToMinutes(tv);
      if (targetMins === null) return 0;
      let prevTV = null, nextTV = null;
      for (const t of sortedTVs) {
        const m = timeValToMinutes(t);
        if (m <= targetMins) prevTV = t;
        else if (nextTV === null) nextTV = t;
      }
      if (prevTV === null) return 0;
      if (nextTV === null) return svgH;
      const m0 = timeValToMinutes(prevTV), m1 = timeValToMinutes(nextTV);
      const y0 = timeYMap.get(prevTV) + NODE_H;  // bottom of last event before this time
      const y1 = timeYMap.get(nextTV);            // top of first event after this time
      const frac = (targetMins - m0) / (m1 - m0);
      return y0 + frac * (y1 - y0);
    }

    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="100%" style="display:block">`);

    // ── Day background bands ──
    const DAY_COLORS = [
      '#f3eeff', // Mon – soft purple
      '#fff8e6', // Tue – warm amber
      '#e6f7ff', // Wed – sky blue
      '#fff3e6', // Thu – peach
      '#fffbe6', // Fri – light gold
      '#e8efff', // Sat – periwinkle blue
      '#edfff3', // Sun – mint green
    ];
    const DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    const firstDay = Math.floor(sortedTVs[0] / 10000);
    const lastDay  = Math.floor(sortedTVs[sortedTVs.length - 1] / 10000);

    for (let day = firstDay; day <= lastDay; day++) {
      const bandY1 = day === firstDay ? 0 : yForTime(day * 10000);
      const bandY2 = day === lastDay  ? svgH : yForTime((day + 1) * 10000);
      const color  = DAY_COLORS[day % 7];
      const name   = DAY_NAMES[day % 7];
      parts.push(`<rect x="0" y="${bandY1.toFixed(1)}" width="${svgW}" height="${(bandY2 - bandY1).toFixed(1)}" fill="${color}"/>`);
      // Day label centered in the band, on the axis side
      const labelY = ((bandY1 + bandY2) / 2).toFixed(1);
      parts.push(`<text class="ccbv-day-band-label" x="${(TIME_AXIS_W - 20).toFixed(1)}" y="${labelY}" text-anchor="end" dominant-baseline="middle">${name}</text>`);
    }

    // ── Time axis (left side) ──
    // Vertical spine
    parts.push(`<line class="ccbv-axis-spine" x1="${TIME_AXIS_W - 8}" y1="0" x2="${TIME_AXIS_W - 8}" y2="${svgH}"/>`);
    // One tick + label per unique draw time
    // Build a map from timeVal → label using node data
    const tvLabels = new Map();
    (function collectLabels(n) {
      if (!n) return;
      if (n.timeVal < 99999 && n.time && !tvLabels.has(n.timeVal))
        tvLabels.set(n.timeVal, n.time);
      collectLabels(n.winChild);
      collectLabels(n.loseChild);
    })(root);

    for (const [tv, label] of tvLabels) {
      const y = timeYMap.get(tv);
      if (y == null) continue;
      const cy = y + NODE_H / 2;  // center of the node at this time
      // Tick mark
      parts.push(`<line class="ccbv-axis-tick" x1="${TIME_AXIS_W - 14}" y1="${cy}" x2="${TIME_AXIS_W - 8}" y2="${cy}"/>`);
      // Horizontal guide line across whole chart
      parts.push(`<line class="ccbv-time-line" x1="${TIME_AXIS_W - 8}" y1="${cy}" x2="${svgW}" y2="${cy}"/>`);
      // Label: split "Saturday 4:00 pm" into two lines
      const parts2 = label.split(' ');
      const day  = parts2[0] || '';
      const time = parts2.slice(1).join(' ');
      parts.push(`<text class="ccbv-axis-day"  x="${TIME_AXIS_W - 16}" y="${cy - 5}"  text-anchor="end">${escXml(day)}</text>`);
      parts.push(`<text class="ccbv-axis-time" x="${TIME_AXIS_W - 16}" y="${cy + 10}" text-anchor="end">${escXml(time)}</text>`);
    }

    // Collect all nodes
    const allNodes = [];
    (function collect(n) { if (!n) return; allNodes.push(n); collect(n.winChild); collect(n.loseChild); })(root);

    // Draw edges first (behind nodes)
    // Edges go from bottom-center of parent to top-center of child
    for (const node of allNodes) {
      const from = pixMap.get(node);
      if (!from) continue;
      const fx = from.x + NODE_W / 2;   // bottom-center X of parent
      const fy = from.y + NODE_H;        // bottom of parent

      for (const [child, edgeCls, label] of [
        [node.winChild,  'win',  'W'],
        [node.loseChild, 'lose', 'L'],
      ]) {
        if (!child) continue;
        const to = pixMap.get(child);
        if (!to) continue;
        const tx = to.x + NODE_W / 2;   // top-center X of child
        const ty = to.y;                 // top of child
        const my = fy + (ty - fy) * 0.5;
        const childState = stateMap.get(child) || 'potential';
        const dashAttr = childState === 'potential' ? ' stroke-dasharray="6,4"' : '';
        parts.push(`<path class="ccbv-edge ccbv-edge-${edgeCls}"${dashAttr} d="M${fx},${fy} C${fx},${my} ${tx},${my} ${tx},${ty}"/>`);
        // Label offset slightly to the side so it doesn't overlap the edge
        const lx = (fx + tx) / 2 + (edgeCls === 'win' ? -10 : 10);
        const ly = my;
        parts.push(`<text class="ccbv-edge-label ccbv-edge-label-${edgeCls}" x="${lx}" y="${ly}" text-anchor="middle">${label}</text>`);
      }
    }

    // Draw nodes
    for (const node of allNodes) {
      const pos = pixMap.get(node);
      if (!pos) continue;
      const { x, y } = pos;
      const tierClass = `ccbv-tier-${node.tier}`;
      const state = stateMap.get(node) || 'potential';
      const stateClass = ` ccbv-state-${state}`;

      parts.push(`<g class="ccbv-node ${tierClass}${stateClass}" transform="translate(${x},${y})">`);
      parts.push(`  <rect width="${NODE_W}" height="${NODE_H}" rx="5"/>`);

      // Game ID
      parts.push(`  <text class="game-id" x="7" y="17">${escXml(node.gameId)}</text>`);

      // Score (if played)
      if (node.score) {
        const icon = node.won === true ? '✓' : node.won === false ? '✗' : '';
        parts.push(`  <text class="game-score" x="${NODE_W - 6}" y="17" text-anchor="end">${escXml(icon + ' ' + node.score)}</text>`);
      } else if (state === 'next') {
        parts.push(`  <text class="game-next-label" x="${NODE_W - 6}" y="17" text-anchor="end">▶ Next</text>`);
      } else if (state === 'potential') {
        parts.push(`  <text class="game-potential-label" x="${NODE_W - 6}" y="17" text-anchor="end">?</text>`);
      }

      // Divider
      parts.push(`  <line x1="0" y1="22" x2="${NODE_W}" y2="22" stroke="rgba(0,0,0,0.15)" stroke-width="1"/>`);

      // Time
      if (node.time) {
        parts.push(`  <text class="game-time" x="7" y="35">${escXml(node.time)}</text>`);
      }

      // Opponent
      if (node.opponent) {
        const opp = node.opponent.length > 18 ? node.opponent.slice(0, 17) + '…' : node.opponent;
        parts.push(`  <text class="game-vs" x="7" y="52">vs ${escXml(opp)}</text>`);
      }

      // Bottom bracket label for potential games
      if (state === 'potential') {
        parts.push(`  <text class="game-tier-hint" x="${NODE_W/2}" y="${NODE_H - 4}" text-anchor="middle">${escXml(node.tier)} bracket</text>`);
      }

      parts.push(`</g>`);
    }

    parts.push('</svg>');
    return parts.join('\n');
  }

  // ── Export ────────────────────────────────────────────────────────────────

  // All SVG-relevant CSS, inlined so exported files are self-contained.
  const EMBEDDED_SVG_CSS = `
    .ccbv-node rect { stroke-width: 1.5; }
    .ccbv-node text { font-size: 11px; font-family: Arial, sans-serif; }
    .game-id   { font-weight: bold; font-size: 12px; font-family: Arial, sans-serif; fill: #222; }
    .game-time { font-size: 10px; fill: #555; font-family: Arial, sans-serif; }
    .game-vs   { font-size: 10px; font-family: Arial, sans-serif; fill: #222; }
    .game-score         { font-size: 11px; font-weight: bold; font-family: Arial, sans-serif; fill: #222; }
    .game-next-label    { font-size: 10px; fill: #e67300; font-weight: bold; font-family: Arial, sans-serif; }
    .game-potential-label { font-size: 13px; fill: #aaa; font-family: Arial, sans-serif; }
    .game-tier-hint     { font-size: 9px; fill: #888; font-family: Arial, sans-serif; }
    .ccbv-edge          { fill: none; stroke-width: 2; }
    .ccbv-edge-label    { font-size: 11px; font-weight: bold; font-family: Arial, sans-serif; }
    .ccbv-edge-win      { stroke: #2a7a2a; }
    .ccbv-edge-lose     { stroke: #c0392b; }
    .ccbv-edge-label-win  { fill: #2a7a2a; }
    .ccbv-edge-label-lose { fill: #c0392b; }
    .ccbv-tier-A rect { fill: #FFFFD7; stroke: #c8c800; }
    .ccbv-tier-B rect { fill: #DCE6F1; stroke: #5b8ec5; }
    .ccbv-tier-C rect { fill: #F0DCDB; stroke: #c57070; }
    .ccbv-tier-D rect { fill: #D7D7FF; stroke: #7070c5; }
    .ccbv-tier-E rect { fill: #e0f0e0; stroke: #70a070; }
    .ccbv-tier-X rect { fill: #f0f0f0; stroke: #999; }
    .ccbv-state-done-win  rect { opacity: 0.75; }
    .ccbv-state-done-lose rect { opacity: 0.4; }
    .ccbv-state-next rect      { stroke-width: 3; stroke: #e67300; }
    .ccbv-state-potential rect { stroke-dasharray: 5,3; opacity: 0.6; }
    .ccbv-day-band-label { font-size: 12px; font-weight: bold; font-family: Arial, sans-serif; fill: #aaa; }
    .ccbv-axis-spine { stroke: #bbb; stroke-width: 1.5; }
    .ccbv-axis-tick  { stroke: #bbb; stroke-width: 1.5; }
    .ccbv-axis-day  { font-size: 11px; font-weight: bold; fill: #444; font-family: Arial, sans-serif; }
    .ccbv-axis-time { font-size: 10px; fill: #666; font-family: Arial, sans-serif; }
    .ccbv-time-line { stroke: #ececec; stroke-width: 1; stroke-dasharray: 4,4; }
  `;

  function exportableSVGString() {
    const svgEl = document.querySelector('#ccbv-svg-wrapper svg');
    if (!svgEl) return null;

    const clone = svgEl.cloneNode(true);

    // Set explicit pixel dimensions from viewBox so it renders at full size
    const [, , vw, vh] = (svgEl.getAttribute('viewBox') || '0 0 800 600')
      .split(' ').map(Number);
    clone.setAttribute('width', vw);
    clone.setAttribute('height', vh);
    clone.removeAttribute('style'); // remove width:100%

    // Embed CSS
    const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    styleEl.textContent = EMBEDDED_SVG_CSS;
    clone.insertBefore(styleEl, clone.firstChild);

    return new XMLSerializer().serializeToString(clone);
  }

  function downloadSVG(teamName) {
    const svgStr = exportableSVGString();
    if (!svgStr) return;
    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${teamName.replace(/[^a-z0-9]/gi, '_')}_bracket.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadPNG(teamName) {
    const svgStr = exportableSVGString();
    if (!svgStr) return;

    const svgEl = document.querySelector('#ccbv-svg-wrapper svg');
    const [, , vw, vh] = (svgEl?.getAttribute('viewBox') || '0 0 800 600')
      .split(' ').map(Number);

    // Render at 2× for retina-quality output
    const scale  = 2;
    const cw = vw * scale, ch = vh * scale;

    const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const img  = new Image();

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);

      const a    = document.createElement('a');
      a.href     = canvas.toDataURL('image/png');
      a.download = `${teamName.replace(/[^a-z0-9]/gi, '_')}_bracket.png`;
      a.click();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // ── Inject UI ─────────────────────────────────────────────────────────────

  function getTeamName() {
    for (const sel of ['p[style*="x-large"]', 'h1', '.team-name']) {
      const el = document.querySelector(sel);
      if (el) return el.textContent.trim();
    }
    return 'Team';
  }

  function init() {
    const root = parseTree();
    if (!root) {
      console.warn('[CCBV] Could not parse game tree. Root game not found.');
      return;
    }

    const teamName = getTeamName();
    const svg = buildSVG(root);

    const container = document.createElement('div');
    container.id = 'ccbv-container';
    container.innerHTML = `
      <h3 style="margin:0 0 8px">Bracket View — ${escXml(teamName)}</h3>
      <div id="ccbv-controls">
        <button id="ccbv-toggle">Hide Original</button>
        <button id="ccbv-dl-svg">⬇ SVG</button>
        <button id="ccbv-dl-png">⬇ PNG</button>
        <span class="ccbv-legend">
          <span class="ccbv-swatch" style="background:#FFFFD7;border-color:#c8c800"></span>A &nbsp;
          <span class="ccbv-swatch" style="background:#DCE6F1;border-color:#5b8ec5"></span>B &nbsp;
          <span class="ccbv-swatch" style="background:#F0DCDB;border-color:#c57070"></span>C &nbsp;
          <span class="ccbv-swatch" style="background:#D7D7FF;border-color:#7070c5"></span>D &nbsp;
          <span style="color:#2a7a2a;font-weight:bold">W</span>=win path &nbsp;
          <span style="color:#c0392b;font-weight:bold">L</span>=lose path
        </span>
      </div>
      <div id="ccbv-svg-wrapper">${svg}</div>
    `;

    // Insert before the root game div
    let anchor = null;
    for (const el of document.querySelectorAll('div[style*="margin-top"]')) {
      if (/Game\s+[A-Z]\d+/i.test(el.textContent)) { anchor = el; break; }
    }
    if (anchor) {
      anchor.parentNode.insertBefore(container, anchor);
    } else {
      (document.querySelector('.field-item') || document.body).appendChild(container);
    }

    document.getElementById('ccbv-dl-svg').addEventListener('click', () => downloadSVG(teamName));
    document.getElementById('ccbv-dl-png').addEventListener('click', () => downloadPNG(teamName));

    // Toggle original view (the root game div + its connector sibling)
    document.getElementById('ccbv-toggle').addEventListener('click', function () {
      const targets = anchor
        ? [anchor, anchor.nextElementSibling].filter(Boolean)
        : [];
      const hidden = targets[0]?.style.display === 'none';
      targets.forEach(t => t.style.display = hidden ? '' : 'none');
      this.textContent = hidden ? 'Hide Original' : 'Show Original';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
