// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const MIN_NUMBER = 1;
const MAX_NUMBER = 32;
const ADMIN_PASSWORD = '1234'; // 主控密碼，可改

app.use(express.static('public'));

// 狀態
// players: { socketId: { id, name, hasName, choice, eliminated } }
let players = {};
let maxPlayers = null;       // 可遊玩人數，由主控輸入
let round = 0;               // 0 表示還沒開始遊戲
let winners = [];            // 本輪贏家的 playerId 陣列
let gameLocked = false;      // 一輪已結算
let choicesVisible = false;  // 是否顯示玩家選的數字
let adminSocketId = null;    // 主控 socket id
let history = [];            // 歷史紀錄

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // 是否可分配成玩家：
  // 僅在「還沒開始第一輪」且已設定 maxPlayers 且未滿時，才分配玩家身分
  if (round === 0 && maxPlayers !== null && getPlayerCount() < maxPlayers) {
    const playerId = allocatePlayerId();
    players[socket.id] = {
      id: playerId,
      name: `玩家 ${playerId}`,
      hasName: false,
      choice: null,
      eliminated: false
    };

    socket.emit('playerInfo', {
      playerId,
      name: players[socket.id].name,
      minNumber: MIN_NUMBER,
      maxNumber: MAX_NUMBER
    });

    console.log(`Assign player #${playerId} to ${socket.id}`);
  } else {
    socket.emit('spectator');
    console.log(`Socket ${socket.id} is spectator`);
  }

  sendState();

  // 管理者登入（主控畫面）
  socket.on('registerAdmin', (password) => {
    if (password === ADMIN_PASSWORD) {
      adminSocketId = socket.id;
      console.log('Admin registered:', socket.id);
      socket.emit('adminStatus', { ok: true });
      sendState();
    } else {
      socket.emit('adminStatus', { ok: false, error: '管理密碼錯誤' });
    }
  });

  // 主控設定可遊玩人數
  socket.on('setPlayerCount', (count) => {
    if (socket.id !== adminSocketId) return;
    const n = parseInt(count, 10);
    if (!Number.isInteger(n) || n <= 0) return;
    if (round > 0) return; // 遊戲開始後就不要再改人數了

    maxPlayers = n;
    console.log(`Max players set to ${maxPlayers}`);
    sendState();
  });

  // 玩家設定暱稱
  socket.on('setName', (name) => {
    if (!players[socket.id]) return;
    if (typeof name !== 'string') return;

    const trimmed = name.trim();
    if (!trimmed) return;

    players[socket.id].name = trimmed;
    players[socket.id].hasName = true;
    console.log(`Player ${players[socket.id].id} set name to "${trimmed}"`);
    sendState();
  });

  // 玩家送出數字
  socket.on('chooseNumber', (number) => {
    const p = players[socket.id];
    if (!p) return;               // 不是玩家
    if (p.eliminated) return;     // 已淘汰
    if (gameLocked) return;       // 這輪已結算
    if (round === 0) return;      // 遊戲尚未開始

    if (typeof number !== 'number') return;
    if (number < MIN_NUMBER || number > MAX_NUMBER) return;
    if (!p.hasName) return;       // 沒暱稱不能選

    p.choice = number;
    console.log(`Player ${p.id} chose ${number}`);

    sendState();

    // 檢查：所有「尚未淘汰、已完成暱稱」的玩家都選好了嗎？
    const activePlayers = getActivePlayers();
    const allChosen =
      activePlayers.length > 0 &&
      activePlayers.every(pl => pl.choice !== null);

    if (allChosen && !gameLocked) {
      settleRound();
    }
  });

  // 主控請求「開始下一輪」
  socket.on('startNextRound', () => {
    if (socket.id !== adminSocketId) {
      console.log('Non-admin tried to start next round:', socket.id);
      return;
    }
    console.log('startNextRound requested from admin:', socket.id);
    startNextRound();
  });

  // 主控重置遊戲
  socket.on('resetGame', () => {
    if (socket.id !== adminSocketId) {
      console.log('Non-admin tried to reset game:', socket.id);
      return;
    }
    console.log('resetGame requested from admin:', socket.id);
    resetGame();
  });

  // 斷線
  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);
    if (players[socket.id]) {
      const removedId = players[socket.id].id;
      delete players[socket.id];
      console.log(`Player ${removedId} removed`);
    }
    if (socket.id === adminSocketId) {
      adminSocketId = null;
      console.log('Admin disconnected.');
    }
    sendState();
  });
});

// 結算一輪
function settleRound() {
  if (gameLocked) return;
  if (round === 0) return;

  gameLocked = true;
  choicesVisible = true;

  const currentPlayers = getActivePlayers(); // 只看未淘汰的玩家
  const countByNumber = new Map();

  for (const p of currentPlayers) {
    if (p.choice == null) continue;
    countByNumber.set(p.choice, (countByNumber.get(p.choice) || 0) + 1);
  }

  const uniqueNumbers = [];
  for (const [num, count] of countByNumber.entries()) {
    if (count === 1) uniqueNumbers.push(num);
  }

  let hasWinner = false;
  let lowestUnique = null;
  let winnerIds = [];
  let winnerNames = [];
  let msg = '';

  if (uniqueNumbers.length === 0) {
    winners = [];
    msg = `第 ${round} 輪：沒有最小唯一數字，請按「開始下一輪」繼續。`;
    console.log(msg);
  } else {
    hasWinner = true;
    lowestUnique = Math.min(...uniqueNumbers);

    const winnerPlayers = currentPlayers.filter(p => p.choice === lowestUnique);
    winnerIds = winnerPlayers.map(p => p.id);
    winnerNames = winnerPlayers.map(p => p.name);
    winners = winnerIds;

    // 將贏家標記為淘汰（之後不能再參與）
    for (const p of winnerPlayers) {
      p.eliminated = true;
    }

    msg = `第 ${round} 輪：數字 ${lowestUnique} 為最小唯一，由 ${winnerNames.join(', ')} 獲勝並淘汰出局！`;
    console.log(msg);
  }

  // 歷史紀錄
  history.push({
    round,
    hasWinner,
    lowestUnique,
    winnerIds,
    winnerNames
  });

  io.emit('roundResult', {
    round,
    hasWinner,
    lowestUnique,
    winners,
    winnerNames,
    message: msg
  });

  sendState();
}

// 開始下一輪：只重置「未淘汰玩家」的 choice
function startNextRound() {
  if (maxPlayers === null) return; // 還沒設定人數就不能開始

  // 第一輪：如果還沒開始過，round == 0 → round 變 1
  if (round === 0) {
    round = 1;
  } else {
    round += 1;
  }

  gameLocked = false;
  choicesVisible = false;
  winners = [];

  for (const p of Object.values(players)) {
    p.choice = null;
  }

  console.log(`---- Start Round ${round} ----`);

  sendState();
  io.emit('newRound', { round });
}

// 重置整個遊戲（清空玩家、紀錄，但保留 admin 登入狀態）
function resetGame() {
  players = {};
  maxPlayers = null;
  round = 0;
  winners = [];
  gameLocked = false;
  choicesVisible = false;
  history = [];

  console.log('*** Game has been reset ***');

  sendState();
  io.emit('gameReset');
}

// 廣播目前狀態
function sendState() {
  const playerList = Object.values(players)
    .sort((a, b) => a.id - b.id)
    .map(p => ({
      id: p.id,
      name: p.name,
      hasName: p.hasName,
      choice: p.choice,
      eliminated: p.eliminated
    }));

  const activePlayers = playerList.filter(p => !p.eliminated);
  const roundActive = round > 0 && !gameLocked;

  io.emit('stateUpdate', {
    round,
    players: playerList,
    winners,
    choicesVisible,
    maxPlayers,
    joinedCount: getPlayerCount(),
    activeCount: activePlayers.length,
    roundActive,
    history
  });
}

// 工具：目前玩家數
function getPlayerCount() {
  return Object.keys(players).length;
}

// 工具：取得未淘汰玩家陣列
function getActivePlayers() {
  return Object.values(players).filter(p => !p.eliminated);
}

// 工具：分配玩家 id（1..maxPlayers 中尚未被用的）
function allocatePlayerId() {
  const used = new Set(Object.values(players).map(p => p.id));
  for (let i = 1; i <= (maxPlayers || 999); i++) {
    if (!used.has(i)) return i;
  }
  // 理論上不會來到這裡
  return (maxPlayers || 0) + 1;
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
