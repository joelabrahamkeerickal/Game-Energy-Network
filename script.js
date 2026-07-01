const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const energyValue = document.getElementById('energyValue');
const levelValue = document.getElementById('levelValue');
const bestValue = document.getElementById('bestValue');
const scoresList = document.getElementById('scoresList');
const statusText = document.getElementById('statusText');
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlayTitle');
const overlayText = document.getElementById('overlayText');
const restartButton = document.getElementById('restartButton');
const nextButton = document.getElementById('nextButton');
const hintButton = document.getElementById('hintButton');
const hintOverlay = document.getElementById('hintOverlay');
const hintContent = document.getElementById('hintContent');
const closeHintButton = document.getElementById('closeHintButton');

const state = {
  width: 0,
  height: 0,
  dpr: 1,
  level: 1,
  score: 0,
  userEnergy: 0,
  carryEnergy: 0,
  nodes: [],
  effects: [],
  levelHint: '',
  levelComplete: false,
  isAnimating: false,
  reactionQueue: [],
  reactionTimer: null,
  lastTime: 0,
  pulse: 0,
  rewardNextBurst: false,
  bestScores: [],
};

const sizeProfiles = {
  small: { required: 3, transfer: 1, radius: 0.072, color: '#7dd3fc', tapCost: 1 },
  medium: { required: 5, transfer: 1, radius: 0.096, color: '#86efac', tapCost: 1 },
  large: { required: 10, transfer: 1, radius: 0.124, color: '#f9d49a', tapCost: 1 },
};

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  state.width = rect.width;
  state.height = rect.height;
  state.dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * state.dpr);
  canvas.height = Math.floor(rect.height * state.dpr);
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  if (state.nodes.length) {
    layoutNodes();
  }
}

function loadBestScores() {
  try {
    const raw = sessionStorage.getItem('energy-network-best-scores');
    state.bestScores = raw ? JSON.parse(raw) : [];
  } catch (error) {
    state.bestScores = [];
  }
}

function saveBestScores() {
  try {
    sessionStorage.setItem('energy-network-best-scores', JSON.stringify(state.bestScores));
  } catch (error) {
    console.warn('Could not save best scores', error);
  }
}

function updateHud() {
  energyValue.textContent = state.userEnergy;
  levelValue.textContent = state.level;
  bestValue.textContent = state.bestScores[0] || 0;
  scoresList.innerHTML = state.bestScores.length
    ? state.bestScores.map((score, index) => `<div>#${index + 1} · ${score}</div>`).join('')
    : '<div>No scores yet</div>';
  statusText.textContent = state.levelComplete
    ? `Level cleared. Score: ${state.score}`
    : state.levelHint;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getNodeById(nodeId) {
  return state.nodes.find((node) => node.id === nodeId);
}

function cloneNodes(nodes) {
  return nodes.map((node) => ({ ...node, neighbors: [...node.neighbors] }));
}

function buildGraph(nodeCount) {
  const rows = 8;
  const cols = 8;
  const nodes = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      if (index >= nodeCount) {
        break;
      }
      nodes.push({
        id: index + 1,
        row,
        col,
        x: (col + 0.5) / cols,
        y: (row + 0.5) / rows,
        currentEnergy: 0,
        requiredEnergy: 0,
        burstTransfer: 0,
        tapCost: 0,
        state: 'active',
        locked: false,
        unlockThreshold: 0,
        absorbCount: 0,
        pulse: Math.random() * Math.PI * 2,
        size: 'small',
      });
    }
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  nodes.forEach((node) => {
    node.neighbors = [];
    const possibleNeighbors = [
      { row: node.row, col: node.col - 1 },
      { row: node.row, col: node.col + 1 },
      { row: node.row - 1, col: node.col },
      { row: node.row + 1, col: node.col },
    ];
    possibleNeighbors.forEach(({ row, col }) => {
      if (row < 0 || col < 0 || row >= rows || col >= cols) {
        return;
      }
      const candidate = nodesById.get(row * cols + col + 1);
      if (candidate) {
        node.neighbors.push(candidate.id);
      }
    });
  });

  return nodes;
}

function getInitialEnergy(requiredEnergy, levelNumber) {
  const difficultyBias = clamp(1 - (levelNumber - 1) / 8, 0.2, 1);
  const target = Math.round(requiredEnergy * (0.35 + difficultyBias * 0.25));
  const variance = levelNumber <= 2 ? 1 : levelNumber <= 4 ? 2 : 3;
  const low = Math.max(0, Math.min(requiredEnergy - 1, target - variance));
  const high = Math.max(low, Math.min(requiredEnergy - 1, target + variance));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function findStartEnergy(nodes, levelNumber) {
  const minimumMoves = levelNumber <= 3 ? 3 : 2;
  let budget = levelNumber <= 2 ? 14 : levelNumber <= 4 ? 18 : 24;
  while (budget <= 36) {
    if (canSolveWithBudget(nodes, budget, 6000) && countSolvableMoves(nodes, budget, minimumMoves)) {
      return budget;
    }
    budget += 1;
  }
  return budget;
}

function countSolvableMoves(nodes, startEnergy, minimumMoves) {
  const candidateMoves = nodes.filter((node) => node.state === 'active' && startEnergy >= node.tapCost);
  let solvableMoves = 0;
  for (let index = 0; index < candidateMoves.length; index += 1) {
    const nextState = simulateTap(nodes, candidateMoves[index].id, startEnergy);
    if (nextState && canSolveWithBudget(nextState.nodes, nextState.userEnergy, 4000)) {
      solvableMoves += 1;
      if (solvableMoves >= minimumMoves) {
        return true;
      }
    }
  }
  return solvableMoves >= minimumMoves;
}

function hasSeparatedSafeNodes(nodes, levelNumber) {
  const lockedNodes = nodes.filter((node) => node.locked);
  if (lockedNodes.length < 2) {
    return false;
  }
  return !lockedNodes.some((node) => node.neighbors.some((neighborId) => {
    const neighbor = nodes.find((entry) => entry.id === neighborId);
    return neighbor && neighbor.locked;
  }));
}

function assignHotNodes(nodes, levelNumber) {
  const hotCount = levelNumber <= 2 ? 4 : 5;
  nodes.forEach((node) => {
    node.hot = false;
  });

  const eligible = nodes.filter((node) => node.state === 'active' && !node.locked);
  const chosen = [];
  const shuffled = [...eligible].sort(() => Math.random() - 0.5);

  shuffled.forEach((node) => {
    if (chosen.length >= hotCount) {
      return;
    }
    const tooClose = chosen.some((picked) => Math.abs(picked.row - node.row) + Math.abs(picked.col - node.col) <= 2);
    if (!tooClose) {
      chosen.push(node);
      node.hot = true;
      node.currentEnergy = Math.max(0, node.requiredEnergy - 1);
    }
  });

  if (chosen.length < hotCount) {
    const fallback = eligible.find((node) => !node.hot);
    if (fallback) {
      fallback.hot = true;
      fallback.currentEnergy = Math.max(0, fallback.requiredEnergy - 1);
    }
  }
}

function createLevel(levelNumber) {
  const sizePool = levelNumber <= 2 ? ['small', 'small', 'medium', 'medium', 'large'] : levelNumber <= 5 ? ['small', 'medium', 'medium', 'large'] : ['small', 'medium', 'large', 'large'];
  let bestAttempt = null;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const nodes = buildGraph(64);
    nodes.forEach((node, index) => {
      const poolIndex = (index + levelNumber + attempt) % sizePool.length;
      const size = sizePool[poolIndex];
      const profile = sizeProfiles[size];
      node.size = size;
      node.requiredEnergy = profile.required + (levelNumber > 1 ? levelNumber % 2 : 0);
      node.burstTransfer = profile.transfer;
      node.tapCost = profile.tapCost;
      node.currentEnergy = getInitialEnergy(node.requiredEnergy, levelNumber);
      node.state = 'active';
      const riskRoll = Math.random();
      if (riskRoll < 0.24) {
        node.currentEnergy = Math.max(0, node.requiredEnergy - 2);
        node.locked = true;
        node.unlockThreshold = 2;
        node.absorbCount = 0;
      } else {
        node.currentEnergy = Math.max(0, Math.min(node.requiredEnergy - 2, node.currentEnergy));
        node.locked = false;
        node.unlockThreshold = 0;
        node.absorbCount = 0;
      }
      node.pulse = Math.random() * Math.PI * 2;
      node.hot = false;
    });

    assignHotNodes(nodes, levelNumber);

    const startEnergy = findStartEnergy(nodes, levelNumber);
    const hasMultipleSolutions = countSolvableMoves(nodes, startEnergy, levelNumber <= 3 ? 3 : 2);
    const mixBalance = nodes.filter((node) => node.locked).length >= 2 && nodes.filter((node) => node.currentEnergy >= node.requiredEnergy - 1).length >= 2;
    const safeSpacingValid = hasSeparatedSafeNodes(nodes, levelNumber);
    if (canSolveWithBudget(nodes, startEnergy, 6000) && hasMultipleSolutions && mixBalance && safeSpacingValid) {
      return { levelNumber, nodes, startEnergy };
    }
    if (!bestAttempt || startEnergy < bestAttempt.startEnergy) {
      bestAttempt = { nodes, startEnergy };
    }
  }

  return { levelNumber, nodes: bestAttempt ? bestAttempt.nodes : buildGraph(64), startEnergy: bestAttempt ? bestAttempt.startEnergy : 16 };
}

function canSolveWithBudget(nodes, startEnergy, maxStates = 6000) {
  const memo = new Map();
  let statesVisited = 0;

  function search(currentNodes, currentEnergy) {
    statesVisited += 1;
    if (statesVisited > maxStates) {
      return false;
    }

    const key = `${currentEnergy}|${currentNodes.map((node) => `${node.state}:${node.currentEnergy}`).join(',')}`;
    if (memo.has(key)) {
      return memo.get(key);
    }
    if (currentNodes.every((node) => node.state === 'dormant')) {
      memo.set(key, true);
      return true;
    }
    if (currentEnergy < 0) {
      memo.set(key, false);
      return false;
    }

    for (let index = 0; index < currentNodes.length; index += 1) {
      const node = currentNodes[index];
      if (node.state !== 'active') {
        continue;
      }
      if (currentEnergy < node.tapCost) {
        continue;
      }
      const nextState = simulateTap(currentNodes, node.id, currentEnergy);
      if (nextState && search(nextState.nodes, nextState.userEnergy)) {
        memo.set(key, true);
        return true;
      }
    }

    memo.set(key, false);
    return false;
  }

  return search(cloneNodes(nodes), startEnergy);
}

function simulateTap(nodes, nodeId, currentEnergy) {
  const nextNodes = cloneNodes(nodes);
  const target = nextNodes.find((node) => node.id === nodeId);
  if (!target || target.state !== 'active') {
    return null;
  }

  let userEnergy = currentEnergy - target.tapCost;
  target.currentEnergy += 1;

  const queue = [target.id];
  while (queue.length) {
    const activeId = queue.shift();
    const burstNode = nextNodes.find((node) => node.id === activeId);
    if (!burstNode || burstNode.state !== 'active') {
      continue;
    }
    if (burstNode.currentEnergy < burstNode.requiredEnergy) {
      continue;
    }
    burstNode.state = 'dormant';
    userEnergy += burstNode.currentEnergy;
    burstNode.neighbors.forEach((neighborId) => {
      const neighbor = nextNodes.find((node) => node.id === neighborId);
      if (!neighbor || neighbor.state !== 'active') {
        return;
      }
      neighbor.currentEnergy += burstNode.burstTransfer;
      if (neighbor.currentEnergy >= neighbor.requiredEnergy) {
        queue.push(neighbor.id);
      }
    });
  }

  return { nodes: nextNodes, userEnergy };
}

function layoutNodes() {
  const paddingX = Math.min(state.width * 0.06, 18);
  const paddingY = Math.min(state.height * 0.08, 18);
  const usableWidth = state.width - paddingX * 2;
  const usableHeight = state.height - paddingY * 2;
  const cols = 8;
  const rows = 8;
  const cellWidth = usableWidth / cols;
  const cellHeight = usableHeight / rows;
  state.nodes.forEach((node) => {
    node.screenX = paddingX + (node.col + 0.5) * cellWidth;
    node.screenY = paddingY + (node.row + 0.5) * cellHeight;
    node.radius = Math.max(22, Math.min(cellWidth, cellHeight) * 0.30);
    node.hitRadius = Math.max(node.radius * 1.12, 24);
  });
}

function startLevel(levelNumber) {
  if (state.reactionTimer) {
    window.clearTimeout(state.reactionTimer);
  }
  const levelData = createLevel(levelNumber);
  state.level = levelNumber;
  state.nodes = levelData.nodes;
  state.userEnergy = levelData.startEnergy;
  state.levelComplete = false;
  state.isAnimating = false;
  state.reactionQueue = [];
  state.reactionTimer = null;
  state.effects = [];
  state.rewardNextBurst = false;
  state.levelHint = `Use ${state.userEnergy} energy or less to wake the network.`;
  layoutNodes();
  updateHud();
  hideOverlay();
}

function spawnBurstEffect(node, burstColor) {
  state.effects.push({
    x: node.screenX,
    y: node.screenY,
    radius: 0,
    life: 1,
    color: burstColor,
    intensity: 1.2,
  });
}

function spawnTransferEffect(sourceNode, targetNode, amount) {
  state.effects.push({
    x: sourceNode.screenX,
    y: sourceNode.screenY,
    targetX: targetNode.screenX,
    targetY: targetNode.screenY,
    progress: 0,
    life: 1,
    color: '#38bdf8',
    intensity: 1,
    amount,
  });
}

function spawnWaveEffect(node) {
  state.effects.push({
    x: node.screenX,
    y: node.screenY,
    radius: node.radius * 0.5,
    life: 0.7,
    color: '#f8fafc',
    intensity: 1.4,
    wave: true,
  });
}

function spawnSmokeEffect(node, burstColor) {
  state.effects.push({
    x: node.screenX,
    y: node.screenY,
    radius: node.radius * 0.18,
    life: 0.8,
    color: burstColor,
    intensity: 1.1,
    smoke: true,
    driftX: (Math.random() - 0.5) * 28,
    driftY: (Math.random() - 0.5) * 28,
  });
}

function queueReaction(nodeId) {
  if (!state.reactionQueue.includes(nodeId)) {
    state.reactionQueue.push(nodeId);
  }
}

function unlockNode(node) {
  if (!node.locked) {
    return;
  }
  node.absorbCount += 1;
  if (node.absorbCount >= node.unlockThreshold) {
    node.locked = false;
    node.state = 'active';
    node.levelHint = 'A previously locked node opened up.';
  }
}

function processReactionStep() {
  if (!state.isAnimating) {
    return;
  }

  const burstId = state.reactionQueue.shift();
  if (!burstId) {
    state.isAnimating = false;
    if (state.nodes.every((entry) => entry.state === 'dormant')) {
      completeLevel();
    } else {
      state.levelHint = 'The chain reaction settled. Tap again when you are ready.';
      updateHud();
    }
    return;
  }

  const activeNode = getNodeById(burstId);
  if (!activeNode || activeNode.state !== 'active' || activeNode.currentEnergy < activeNode.requiredEnergy) {
    state.reactionTimer = window.setTimeout(processReactionStep, 180);
    return;
  }

  activeNode.state = 'dormant';
  spawnBurstEffect(activeNode, activeNode.size === 'large' ? '#fb7185' : '#38bdf8');
  spawnSmokeEffect(activeNode, activeNode.size === 'large' ? '#fde68a' : '#f8fafc');
  spawnWaveEffect(activeNode);
  if (state.rewardNextBurst) {
    state.userEnergy += activeNode.currentEnergy;
    state.rewardNextBurst = false;
  }

  activeNode.neighbors.forEach((neighborId) => {
    const neighbor = getNodeById(neighborId);
    if (!neighbor || neighbor.state !== 'active') {
      return;
    }

    const remainingCapacity = neighbor.requiredEnergy - neighbor.currentEnergy;
    const transferAmount = Math.min(activeNode.burstTransfer, remainingCapacity);
    if (transferAmount <= 0) {
      return;
    }

    spawnTransferEffect(activeNode, neighbor, transferAmount);
    neighbor.currentEnergy += transferAmount;
    if (neighbor.locked) {
      unlockNode(neighbor);
    }
    if (neighbor.currentEnergy >= neighbor.requiredEnergy) {
      queueReaction(neighbor.id);
    }
  });

  updateHud();
  state.reactionTimer = window.setTimeout(processReactionStep, 260);
}

function applyTap(nodeId) {
  if (state.levelComplete || state.isAnimating) {
    return;
  }
  const node = getNodeById(nodeId);
  if (!node || node.locked || state.userEnergy < node.tapCost) {
    state.levelHint = 'Not enough energy. Tap a different node or restart.';
    updateHud();
    return;
  }

  const tapCost = 1;
  state.userEnergy -= tapCost;
  node.state = 'active';
  node.currentEnergy += 1;
  state.levelHint = `Tap cost: ${tapCost} energy.`;

  if (node.currentEnergy >= node.requiredEnergy) {
    state.isAnimating = true;
    state.rewardNextBurst = true;
    queueReaction(node.id);
    processReactionStep();
  } else {
    updateHud();
  }
}

function completeLevel() {
  state.levelComplete = true;
  const scoreEarned = state.userEnergy * 100;
  state.score += scoreEarned;
  state.carryEnergy = 0;
  state.bestScores.push(state.score);
  state.bestScores.sort((a, b) => b - a);
  state.bestScores = state.bestScores.slice(0, 3);
  saveBestScores();
  overlayTitle.textContent = 'Level complete';
  overlayText.textContent = `Score from this level: ${scoreEarned}. Total score: ${state.score}`;
  showOverlay();
  updateHud();
}

function showOverlay() {
  overlay.classList.remove('hidden');
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

function showHintOverlay() {
  const rules = [
    '<strong>Tap</strong> - Tap on any node to charge it with energy. Each tap adds 1 unit energy to the selected node.',
    '<strong>Burst</strong> - When a node reaches its burst threshold, it bursts and sends energy to immediate neighbors only.',
    '<strong>Node colors</strong> - Blue nodes need 3 units to burst, green need 5, and pale yellow need 10.',
    '<strong>Safe nodes</strong> - Safe nodes are hidden behind a shell until they absorb 3 units of energy from neighbors.',
    '<strong>Hot nodes</strong> - Hot nodes are the shaking ones that only need one more unit of energy and will burst on the next tap.',
  ];
  hintContent.innerHTML = rules.map((rule) => `<div>${rule}</div>`).join('');
  hintOverlay.classList.remove('hidden');
}

function hideHintOverlay() {
  hintOverlay.classList.add('hidden');
}

function drawBackground() {
  const gradient = ctx.createLinearGradient(0, 0, 0, state.height);
  gradient.addColorStop(0, '#0f172a');
  gradient.addColorStop(1, '#020617');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, state.width, state.height);

  ctx.save();
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.11)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i += 1) {
    const y = (state.height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(state.width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawNode(node) {
  const { screenX, screenY, radius } = node;
  const profile = sizeProfiles[node.size];
  const energyRatio = clamp(node.currentEnergy / node.requiredEnergy, 0, 1);
  const active = node.state === 'active';
  const drawRadius = radius * (0.86 + energyRatio * 0.25);
  const isHot = Boolean(node.hot) && !node.locked && node.state === 'active' && node.currentEnergy < node.requiredEnergy;
  const isLocked = node.locked;
  const showLabel = !isHot && !isLocked;
  const hotOffsetX = isHot ? Math.sin(state.pulse * 14 + node.pulse) * 1.2 : 0;
  const hotOffsetY = isHot ? Math.cos(state.pulse * 14 + node.pulse * 1.3) * 0.9 : 0;
  const nodeX = screenX + hotOffsetX;
  const nodeY = screenY + hotOffsetY;
  const hotPulse = isHot ? 0.6 + 0.25 * Math.sin(state.pulse * 10 + node.pulse) : 0;

  if (active) {
    const shellProgress = isLocked ? clamp(node.absorbCount / Math.max(1, node.unlockThreshold), 0, 1) : 0;
    ctx.save();
    ctx.translate(nodeX, nodeY);

    const fillGradient = ctx.createRadialGradient(-drawRadius * 0.28, -drawRadius * 0.3, drawRadius * 0.1, 0, 0, drawRadius);
    fillGradient.addColorStop(0, '#f8fafc');
    fillGradient.addColorStop(0.34, profile.color);
    fillGradient.addColorStop(1, 'rgba(2, 6, 23, 0.95)');

    ctx.shadowColor = 'rgba(2, 6, 23, 0.35)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(0, 0, drawRadius, 0, Math.PI * 2);
    ctx.fillStyle = fillGradient;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(-drawRadius * 0.28, -drawRadius * 0.28, drawRadius * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.fill();

    if (isHot) {
      ctx.save();
      ctx.shadowColor = `rgba(251, 113, 133, ${0.24 + hotPulse * 0.16})`;
      ctx.shadowBlur = 10 + hotPulse * 8;
      ctx.beginPath();
      ctx.arc(0, 0, drawRadius * 0.96, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(251, 113, 133, ${0.06 + hotPulse * 0.08})`;
      ctx.fill();
      ctx.restore();
    }

    if (showLabel) {
      ctx.save();
      ctx.font = `${Math.max(11, radius * 0.46)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(248, 250, 252, 0.95)';
      ctx.shadowColor = 'rgba(2, 6, 23, 0.65)';
      ctx.shadowBlur = 4;
      ctx.fillText(`${node.currentEnergy}`, 0, 0);
      ctx.restore();
    }

    if (isLocked) {
      const shellRadius = drawRadius * 0.9;
      const shellOpacity = 0.95 - shellProgress * 0.18;
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, shellRadius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(248, 250, 252, ${shellOpacity})`;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(0, 0, shellRadius * 0.72, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.fill();

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.9)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(0, 0, shellRadius, 0, Math.PI * 2);
      ctx.stroke();

      const crackCount = 4 + Math.floor(shellProgress * 4);
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.9)';
      ctx.lineWidth = 1.1;
      for (let index = 0; index < crackCount; index += 1) {
        const angle = ((index + 1) / (crackCount + 1)) * Math.PI * 2;
        const crackLength = drawRadius * (0.16 + shellProgress * 0.16);
        const crackX = Math.cos(angle) * crackLength;
        const crackY = Math.sin(angle) * crackLength;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(crackX, crackY);
        ctx.stroke();
      }

      const innerGlow = 0.18 + shellProgress * 0.18;
      ctx.beginPath();
      ctx.arc(0, 0, shellRadius * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(56, 189, 248, ${innerGlow})`;
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  } else {
    ctx.save();
    ctx.translate(nodeX, nodeY);
    ctx.beginPath();
    ctx.arc(0, 0, drawRadius * 0.95, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, drawRadius * 0.72, 0, Math.PI * 2);
    ctx.fillStyle = '#334155';
    ctx.fill();
    ctx.restore();
  }
}

function drawEffects(delta) {
  state.effects = state.effects.filter((effect) => {
    effect.life -= delta * 2;
    if (effect.targetX !== undefined) {
      effect.progress += delta * 3.4;
      if (effect.progress >= 1) {
        return false;
      }
      const x = effect.x + (effect.targetX - effect.x) * effect.progress;
      const y = effect.y + (effect.targetY - effect.y) * effect.progress;
      ctx.save();
      ctx.strokeStyle = effect.color;
      ctx.lineWidth = 2.2 + effect.intensity * 0.8;
      ctx.shadowBlur = 12;
      ctx.shadowColor = effect.color;
      ctx.beginPath();
      ctx.moveTo(effect.x, effect.y);
      ctx.lineTo(x, y);
      ctx.stroke();

      const labelX = effect.x + (effect.targetX - effect.x) * 0.5;
      const labelY = effect.y + (effect.targetY - effect.y) * 0.5;
      ctx.fillStyle = '#f8fafc';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${effect.amount}`, labelX, labelY);
      ctx.restore();
      return true;
    }

    if (effect.smoke) {
      effect.radius += delta * (70 + effect.intensity * 35);
      effect.x += effect.driftX * delta * 0.6;
      effect.y += effect.driftY * delta * 0.6;
      if (effect.life <= 0) {
        return false;
      }
      ctx.save();
      ctx.globalAlpha = Math.max(0, effect.life * 0.45);
      ctx.fillStyle = effect.color;
      ctx.beginPath();
      ctx.arc(effect.x, effect.y, effect.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return true;
    }

    effect.radius += delta * (160 + effect.intensity * 70);
    if (effect.life <= 0) {
      return false;
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(effect.x, effect.y, effect.radius, 0, Math.PI * 2);
    if (effect.wave) {
      ctx.strokeStyle = 'rgba(248,250,252,0.7)';
      ctx.lineWidth = 1.8;
    } else {
      ctx.strokeStyle = effect.color.replace('cc', '88');
      ctx.lineWidth = 2.4 + effect.intensity * 0.8;
    }
    ctx.shadowBlur = 16;
    ctx.shadowColor = effect.color;
    ctx.stroke();
    ctx.restore();
    return true;
  });
}

function render() {
  drawBackground();
  drawEffects(1 / 60);
  state.nodes.forEach(drawNode);
}

function animate(timestamp) {
  const delta = Math.min(0.025, (timestamp - state.lastTime) / 1000 || 0.016);
  state.lastTime = timestamp;
  state.pulse += delta * 5;
  render();
  requestAnimationFrame(animate);
}

function pointerToCanvas(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function handlePointerDown(event) {
  const { x, y } = pointerToCanvas(event);
  const hitNode = state.nodes.find((node) => {
    if (node.locked) {
      return false;
    }
    const dx = x - node.screenX;
    const dy = y - node.screenY;
    const hitRadius = node.hitRadius || node.radius * 1.1;
    return dx * dx + dy * dy <= hitRadius * hitRadius;
  });
  if (hitNode) {
    applyTap(hitNode.id);
  }
}

function bindEvents() {
  canvas.addEventListener('pointerdown', handlePointerDown);
  restartButton.addEventListener('click', () => startLevel(state.level));
  nextButton.addEventListener('click', () => startLevel(state.level + 1));
  hintButton.addEventListener('click', () => {
    showHintOverlay();
    state.levelHint = 'Hint shown. Watch for hot and safe nodes.';
    updateHud();
  });
  closeHintButton.addEventListener('click', () => {
    hideHintOverlay();
  });
  window.addEventListener('resize', resizeCanvas);
}

function init() {
  loadBestScores();
  resizeCanvas();
  bindEvents();
  startLevel(1);
  updateHud();
  requestAnimationFrame(animate);
}

init();
