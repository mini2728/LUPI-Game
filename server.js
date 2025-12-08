// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const MIN_NUMBER = 1;
const MAX_NUMBER = 30;
const ADMIN_PASSWORD = '53206993'; // 主控密碼，可改

app.use(express.static('public'));

// 狀態
// players: { clientId: { id, name, hasName, choice, eliminated, connected } }
// socketToClientId: { socketId: clientId }
let players = {};
let socketToClientId = {};
let maxPlayers = null;       // 可遊玩人數，由主控輸入
let round = 0;               // 0 表示還沒開始遊戲
let winners = [];            // 本輪贏家的 playerId 陣列
let gameLocked = false;      // 一輪已結算
let choicesVisible = false;  // 是否顯示玩家選的數字
let adminSocketId = null;    // 主控 socket id
let history = [];            // 歷史紀錄

io.on('connection', (socket) => {
  const clientId = socket.handshake?.auth?.clientId;
  console.log('New connection:', socket.id, 'clientId:', clientId || '(none)');

  // 若帶有 clientId，視為玩家端連線；否則當成一般觀眾 / 主控端
  if (clientId) {
    socketToClientId[socket.id] = clientId;

    let p = players[clientId];

    if (p) {
      // 斷線重連：沿用原本的玩家資料
      p.connected = true;
      console.log(`Reconnected player #${p.id} for clientId ${clientId}`);

      socket.emit('playerInfo', {
        playerId: p.id,
        name: p.name,
        minNumber: MIN_NUMBER,
        maxNumber: MAX_NUMBER
      });
    } else {
      // 新玩家：只有在遊戲尚未開始 (round === 0) 且有設定 maxPlayers 且尚未滿時才建立
      if (round === 0 && maxPlayers !== null && getPlayerCount() < maxPlayers) {
        const playerId = allocatePlayerId();
        p = {
          id: playerId,
          name: `玩家 ${playerId}`,
          hasName: false,
          choice: null,
          eliminated: false,
          connected: true
        };
        players[clientId] = p;

        console.log(`Assign player #${playerId} to clientId ${clientId} (socket ${socket.id})`);

        socket.emit('playerInfo', {
          playerId,
          name: p.name,
          minNumber: MIN_NUMBER,
          maxNumber: MAX_NUMBER
        });
      } else {
        console.log(`Client ${clientId} is spectator (round=${round}, maxPlayers=${maxPlayers})`);
        socket.emit('spectator');
      }
    }
  } else {
    // 沒帶 clientId，多半是主控頁面或旁觀者
    socket.emit('spectator');
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
    const clientId = socketToClientId[socket.id];
    if (!clientId) return;
    const p = players[clientId];
    if (!p) return;
    if (typeof name !== 'string') return;

    const trimmed = name.trim();
    if (!trimmed) return;

    p.name = trimmed;
    p.hasName = true;
    console.log(`Player ${p.id} (clientId ${clientId}) set name to "${trimmed}"`);
    sendState();
  });

  // 玩家送出數字
  socket.on('chooseNumber', (number) => {
    const clientId = socketToClientId[socket.id];
    if (!clientId) return;
    const p = players[clientId];
    if (!p) return;

    if (p.eliminated) return;     // 已淘汰
    if (gameLocked) return;       // 這輪已結算
    if (round === 0) return;      // 遊戲尚未開始

    if (typeof number !== 'number') return;
    if (number < MIN_NUMBER || number > MAX_NUMBER) return;
    if (!p.hasName) return;       // 沒暱稱不能選

    p.choice = number;
    console.log(`Player ${p.id} chose ${number}`);

    // 只更新狀態，不自動結算，等待主控按「開始統計」
    sendState();
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

  // ⭐ 主控決定「開始統計」（結算本輪）
  socket.on('settleRound', () => {
    if (socket.id !== adminSocketId) {
      console.log('Non-admin tried to settle round:', socket.id);
      return;
    }
    console.log('settleRound requested from admin:', socket.id);
    settleRound();
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

  // ⭐ 主控剔除玩家
  socket.on('kickPlayer', (playerId) => {
    if (socket.id !== adminSocketId) {
      console.log('Non-admin tried to kick player:', socket.id);
      return;
    }
    if (typeof playerId !== 'number') return;
    kickPlayer(playerId);
  });

  // 斷線
  socket.on('disconnect', () => {
    console.log('Disconnected:', socket.id);

    const clientId = socketToClientId[socket.id];
    if (clientId && players[clientId]) {
      players[clientId].connected = false;
      console.log(`Player ${players[clientId].id} (clientId ${clientId}) marked disconnected`);
    }
    delete socketToClientId[socket.id];

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

  const currentPlayers = getActivePlayers(); // 只看未淘汰且在線的玩家
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

    msg = `第 ${round} 輪：數字 ${lowestUnique} 為最小唯一，由 ${winnerNames.join(', ')} 獲勝！`;
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

// 開始下一輪：只重置 choice
function startNextRound() {
  if (maxPlayers === null) return; // 還沒設定人數就不能開始

  if (round === 0) {
    round = 1; // 第一輪
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

// 重置整個遊戲（清空玩家、紀錄，並斷線所有非主控連線）
function resetGame() {
  console.log('*** Game has been reset by admin ***');

  // 先廣播給前端：遊戲已重置
  io.emit('gameReset');

  // 把所有「非主控」的 socket 全部踢下線
  for (const [socketId, socket] of io.sockets.sockets) {
    if (socketId === adminSocketId) continue; // 保留主控
    socket.disconnect(true);
  }

  // 清空所有伺服器端的遊戲資料
  players = {};
  socketToClientId = {};
  maxPlayers = null;
  round = 0;
  winners = [];
  gameLocked = false;
  choicesVisible = false;
  history = [];

  // 重新送一次狀態（此時大概只剩主控在聽）
  sendState();
}

// 主控剔除某位玩家
function kickPlayer(playerId) {
  let found = false;

  for (const [clientId, p] of Object.entries(players)) {
    if (p.id === playerId) {
      found = true;

      // 遊戲尚未開始：直接刪掉這個席位，讓別人可以補上
      if (round === 0) {
        console.log(`Kick player #${playerId} (before game start), remove seat`);
        delete players[clientId];
      } else {
        // 遊戲已開始：標記為淘汰
        console.log(`Kick player #${playerId} (in game), mark eliminated`);
        p.eliminated = true;
        p.choice = null;
      }

      // 把這個玩家目前的 socket 全部斷線
      for (const [socketId, cid] of Object.entries(socketToClientId)) {
        if (cid === clientId) {
          const s = io.sockets.sockets.get(socketId);
          if (s) s.disconnect(true);
          delete socketToClientId[socketId];
        }
      }
    }
  }

  if (found) {
    console.log(`Admin kicked player #${playerId}`);
    sendState();
  } else {
    console.log(`kickPlayer: player #${playerId} not found`);
  }
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
      // 若未來想顯示在線狀態，可另外加 connected: p.connected
    }));

  const activePlayers = getActivePlayers();
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

// 工具：目前玩家「席位」數（包含離線但尚未被重置者）
function getPlayerCount() {
  return Object.keys(players).length;
}

// 工具：取得「未淘汰且在線」玩家陣列
function getActivePlayers() {
  return Object.values(players).filter(p => !p.eliminated && p.connected);
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
