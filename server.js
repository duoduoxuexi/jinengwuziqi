const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOARD_SIZE = 15;

const SKILL_IDS = ['fly', 'force_skip', 'time_rewind', 'star_pick'];

const rooms = new Map();

function createBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

function createSkillState() {
  const skills = {};
  for (const id of SKILL_IDS) {
    skills[id] = false;
  }
  return skills;
}

function createRoom(roomId) {
  return {
    id: roomId,
    board: createBoard(),
    players: { black: null, white: null },
    spectators: [],
    playerSkills: {},
    turn: 'black',
    winner: null,
    history: [],
    pendingSkip: { black: false, white: false },
    clients: new Set(),
    createdAt: Date.now()
  };
}

function getRoom(roomId) {
  if (!roomId) return null;
  if (!rooms.has(roomId)) {
    rooms.set(roomId, createRoom(roomId));
  }
  return rooms.get(roomId);
}

function serializeRoom(room) {
  return {
    id: room.id,
    board: room.board,
    turn: room.turn,
    winner: room.winner,
    history: room.history.slice(-20),
    players: {
      black: room.players.black
        ? {
            id: room.players.black.id,
            name: room.players.black.name,
            skills: room.playerSkills[room.players.black.id]
          }
        : null,
      white: room.players.white
        ? {
            id: room.players.white.id,
            name: room.players.white.name,
            skills: room.playerSkills[room.players.white.id]
          }
        : null
    },
    spectators: room.spectators.map((s) => ({ id: s.id, name: s.name })),
    pendingSkip: room.pendingSkip
  };
}

function opponentColor(color) {
  return color === 'black' ? 'white' : 'black';
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Request body too large'));
        req.connection.destroy();
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        const json = JSON.parse(data);
        resolve(json);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJSON(res, status, { error: message });
}

function broadcast(room, type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of room.clients) {
    try {
      client.res.write(payload);
    } catch (error) {
      console.error('Failed to push event', error);
    }
  }
}

function broadcastState(room, extra = {}) {
  broadcast(room, 'state', {
    state: serializeRoom(room),
    ...extra
  });
}

function checkWin(board, x, y, color) {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1]
  ];
  for (const [dx, dy] of directions) {
    let count = 1;
    let nx = x + dx;
    let ny = y + dy;
    while (
      nx >= 0 &&
      nx < BOARD_SIZE &&
      ny >= 0 &&
      ny < BOARD_SIZE &&
      board[ny][nx] === color
    ) {
      count += 1;
      nx += dx;
      ny += dy;
    }
    nx = x - dx;
    ny = y - dy;
    while (
      nx >= 0 &&
      nx < BOARD_SIZE &&
      ny >= 0 &&
      ny < BOARD_SIZE &&
      board[ny][nx] === color
    ) {
      count += 1;
      nx -= dx;
      ny -= dy;
    }
    if (count >= 5) {
      return true;
    }
  }
  return false;
}

function ensureSkillAvailable(room, playerId, skillId) {
  if (!SKILL_IDS.includes(skillId)) {
    throw new Error('未知技能');
  }
  const skills = room.playerSkills[playerId];
  if (!skills) {
    throw new Error('未注册技能状态');
  }
  if (skills[skillId]) {
    throw new Error('技能已被使用');
  }
  skills[skillId] = true;
}

async function handleJoin(req, res) {
  try {
    const { roomId: requestedRoomId, name } = await parseBody(req);
    const playerName = (name || '').trim() || '玩家';
    const roomId = requestedRoomId || randomRoomId();
    const room = getRoom(roomId);
    const playerId = randomUUID();

    let color = null;
    if (!room.players.black) {
      color = 'black';
      room.players.black = { id: playerId, name: playerName, color };
    } else if (!room.players.white) {
      color = 'white';
      room.players.white = { id: playerId, name: playerName, color };
    } else {
      color = 'spectator';
      room.spectators.push({ id: playerId, name: playerName });
    }

    room.playerSkills[playerId] = createSkillState();

    broadcastState(room, {
      message: `${playerName} 加入了房间${color === 'spectator' ? '（观战）' : ''}`
    });

    sendJSON(res, 200, {
      roomId,
      playerId,
      color,
      state: serializeRoom(room)
    });
  } catch (error) {
    console.error('Join failed', error);
    sendError(res, 400, error.message || '无法加入房间');
  }
}

function handleEventStream(req, res, query) {
  const { roomId, playerId } = query;
  if (!roomId || !playerId) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('缺少 roomId 或 playerId');
    return;
  }
  const room = getRoom(roomId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  const client = { res, playerId };
  room.clients.add(client);

  res.write(`event: state\ndata: ${JSON.stringify({ state: serializeRoom(room) })}\n\n`);

  req.on('close', () => {
    room.clients.delete(client);
    if (room.players.black && room.players.black.id === playerId) {
      // player disconnected but keep seat for reconnection
    } else if (room.players.white && room.players.white.id === playerId) {
      // keep seat
    } else {
      const index = room.spectators.findIndex((s) => s.id === playerId);
      if (index >= 0) {
        const [spectator] = room.spectators.splice(index, 1);
        broadcastState(room, { message: `${spectator.name} 离开了观战` });
      }
    }
  });
}

async function handleMove(req, res) {
  try {
    const { roomId, playerId, x, y, skillId } = await parseBody(req);
    if (
      roomId === undefined ||
      playerId === undefined ||
      x === undefined ||
      y === undefined
    ) {
      throw new Error('参数不完整');
    }
    const room = getRoom(roomId);
    if (room.winner) {
      throw new Error('对局已结束');
    }
    const player =
      (room.players.black && room.players.black.id === playerId && room.players.black) ||
      (room.players.white && room.players.white.id === playerId && room.players.white);
    if (!player) {
      throw new Error('没有落子的权限');
    }
    if (player.color !== room.turn) {
      throw new Error('还没有轮到你');
    }
    if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
      throw new Error('坐标超出棋盘');
    }
    if (room.board[y][x]) {
      throw new Error('该位置已有棋子');
    }

    let retainTurn = false;
    if (skillId) {
      if (skillId === 'fly') {
        ensureSkillAvailable(room, playerId, skillId);
        retainTurn = true;
      } else {
        throw new Error('该技能不能与落子同时使用');
      }
    }

    room.board[y][x] = player.color;
    room.history.push({ type: 'move', x, y, color: player.color, skillId: skillId || null });

    if (checkWin(room.board, x, y, player.color)) {
      room.winner = player.color;
      broadcastState(room, {
        message: `${player.name} 达成五连，${player.color === 'black' ? '黑方' : '白方'}获胜！`
      });
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (!retainTurn) {
      const next = opponentColor(player.color);
      if (room.pendingSkip[next]) {
        room.pendingSkip[next] = false;
        // opponent skipped, current player continues
        broadcastState(room, {
          message: `${player.name} 触发了强制上门，继续出手！`
        });
        sendJSON(res, 200, { ok: true });
        return;
      }
      room.turn = next;
    } else {
      broadcastState(room, { message: `${player.name} 使用飞步走石获得额外回合` });
    }

    broadcastState(room, {
      message: `${player.name} 落子（${player.color === 'black' ? '黑子' : '白子'}）`
    });
    sendJSON(res, 200, { ok: true });
  } catch (error) {
    console.error('Move failed', error);
    sendError(res, 400, error.message || '无法落子');
  }
}

async function handleSkill(req, res) {
  try {
    const { roomId, playerId, skillId, target } = await parseBody(req);
    if (!roomId || !playerId || !skillId) {
      throw new Error('参数不完整');
    }
    const room = getRoom(roomId);
    if (room.winner) {
      throw new Error('对局已结束');
    }
    const player =
      (room.players.black && room.players.black.id === playerId && room.players.black) ||
      (room.players.white && room.players.white.id === playerId && room.players.white);
    if (!player) {
      throw new Error('没有使用技能的权限');
    }
    if (player.color !== room.turn && skillId !== 'time_rewind') {
      throw new Error('还没有轮到你');
    }

    switch (skillId) {
      case 'force_skip': {
        ensureSkillAvailable(room, playerId, skillId);
        const opp = opponentColor(player.color);
        room.pendingSkip[opp] = true;
        broadcastState(room, { message: `${player.name} 使用强制上门，${opp === 'black' ? '黑方' : '白方'}下回合将被跳过` });
        sendJSON(res, 200, { ok: true });
        break;
      }
      case 'time_rewind': {
        ensureSkillAvailable(room, playerId, skillId);
        if (room.history.length === 0) {
          throw new Error('没有可撤销的落子');
        }
        const last = room.history.pop();
        if (last.type === 'move') {
          room.board[last.y][last.x] = null;
          room.winner = null;
          room.turn = last.color;
          broadcastState(room, {
            message: `${player.name} 使用时光倒流，撤回了上一手`
          });
          sendJSON(res, 200, { ok: true });
        } else if (last.type === 'remove') {
          room.board[last.y][last.x] = last.color;
          room.turn = opponentColor(player.color);
          broadcastState(room, {
            message: `${player.name} 使用时光倒流，恢复了被移除的棋子`
          });
          sendJSON(res, 200, { ok: true });
        } else {
          throw new Error('未知的历史记录类型');
        }
        break;
      }
      case 'star_pick': {
        ensureSkillAvailable(room, playerId, skillId);
        if (!target || target.x === undefined || target.y === undefined) {
          throw new Error('请选择要移除的棋子');
        }
        const { x, y } = target;
        if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
          throw new Error('坐标超出棋盘');
        }
        const current = room.board[y][x];
        if (!current) {
          throw new Error('该位置没有棋子');
        }
        if (current === player.color) {
          throw new Error('不能移除自己的棋子');
        }
        room.board[y][x] = null;
        room.history.push({ type: 'remove', x, y, color: current, by: player.color });
        room.turn = opponentColor(player.color);
        broadcastState(room, {
          message: `${player.name} 使用拾空摘星，移除了对手的一枚棋子`
        });
        sendJSON(res, 200, { ok: true });
        break;
      }
      case 'fly': {
        throw new Error('请在落子时使用飞步走石');
      }
      default:
        throw new Error('未知技能');
    }
  } catch (error) {
    console.error('Skill failed', error);
    sendError(res, 400, error.message || '技能使用失败');
  }
}

function randomRoomId() {
  const chars = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < 8; i += 1) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname);
  if (pathname === '/' || pathname === '') {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found');
      } else {
        res.writeHead(500);
        res.end('Server Error');
      }
      return;
    }
    const ext = path.extname(filePath);
    const type =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
        ? 'application/javascript; charset=utf-8'
        : ext === '.svg'
        ? 'image/svg+xml'
        : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const { pathname } = parsedUrl;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && pathname === '/api/join') {
    handleJoin(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/move') {
    handleMove(req, res);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/skill') {
    handleSkill(req, res);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/events') {
    handleEventStream(req, res, parsedUrl.query);
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`技能五子棋服务器已启动，端口 ${PORT}`);
});
