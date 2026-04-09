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
  const COL_GAP = 50;   // horizontal gap between columns
  const ROW_GAP = 14;   // vertical gap between rows
  const AXIS_H = 0;     // no separate time axis — time is shown inside nodes

  /** Count the number of leaf nodes in a subtree. */
  function leafCount(node) {
    if (!node) return 0;
    const wc = leafCount(node.winChild);
    const lc = leafCount(node.loseChild);
    return (wc + lc) || 1;
  }

  /**
   * Assign depth (column) to every node via BFS from root.
   * Win and lose children are both one column to the right of their parent.
   * Nodes at the same depth may share a column even if on different bracket tiers.
   */
  function assignDepths(root) {
    const depthMap = new Map();
    const queue = [[root, 0]];
    while (queue.length) {
      const [node, d] = queue.shift();
      if (!node || depthMap.has(node)) continue;
      depthMap.set(node, d);
      if (node.winChild) queue.push([node.winChild, d + 1]);
      if (node.loseChild) queue.push([node.loseChild, d + 1]);
    }
    return depthMap;
  }

  /** Compute row positions (0-based float) via subtree centering. */
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
    const depthMap = assignDepths(root);
    const rowMap   = new Map();
    assignRows(root, 0, rowMap);

    const totalRows = leafCount(root);
    const colW = NODE_W + COL_GAP;
    const rowH = NODE_H + ROW_GAP;
    const maxDepth = Math.max(...depthMap.values());
    const svgW = (maxDepth + 1) * colW + 20;
    const svgH = AXIS_H + totalRows * rowH + ROW_GAP;

    const pixMap = new Map();
    for (const [node, row] of rowMap) {
      const col = depthMap.get(node) ?? 0;
      pixMap.set(node, {
        x: col * colW + 10,
        y: AXIS_H + row * rowH + ROW_GAP / 2,
      });
    }

    return { pixMap, svgW, svgH };
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
    const { pixMap, svgW, svgH } = layout(root);
    const stateMap = markStates(root);

    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`);

    // Collect all nodes
    const allNodes = [];
    (function collect(n) { if (!n) return; allNodes.push(n); collect(n.winChild); collect(n.loseChild); })(root);

    // Draw edges first (behind nodes)
    for (const node of allNodes) {
      const from = pixMap.get(node);
      if (!from) continue;
      const fx = from.x + NODE_W;
      const fy = from.y + NODE_H / 2;

      for (const [child, edgeCls, label] of [
        [node.winChild,  'win',  'W'],
        [node.loseChild, 'lose', 'L'],
      ]) {
        if (!child) continue;
        const to = pixMap.get(child);
        if (!to) continue;
        const tx = to.x;
        const ty = to.y + NODE_H / 2;
        const mx = fx + (tx - fx) * 0.55;
        // Dashed edge for potential future games
        const childState = stateMap.get(child) || 'potential';
        const dashAttr = childState === 'potential' ? ' stroke-dasharray="6,4"' : '';
        parts.push(`<path class="ccbv-edge ccbv-edge-${edgeCls}"${dashAttr} d="M${fx},${fy} C${mx},${fy} ${mx},${ty} ${tx},${ty}"/>`);
        const lx = (fx + tx) / 2;
        const ly = (fy + ty) / 2;
        parts.push(`<text class="ccbv-edge-label ccbv-edge-label-${edgeCls}" x="${lx}" y="${ly + 4}" text-anchor="middle">${label}</text>`);
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
