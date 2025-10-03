(() => {
  const BOARD_SIZE = 15;
  const API_BASE = '';

  const SKILLS = [
    {
      id: 'fly',
      name: '飞步走石',
      tag: '额外回合',
      description: '在本回合落子时发动，落子后仍由你继续出手。',
      type: 'prepare'
    },
    {
      id: 'force_skip',
      name: '强制上门',
      tag: '跳过对手',
      description: '使对手的下一回合被跳过，常用于形成连续攻势。',
      type: 'instant'
    },
    {
      id: 'star_pick',
      name: '拾空摘星',
      tag: '拆除棋子',
      description: '选择对手的一枚棋子将其移除，打破成型的连珠。',
      type: 'target'
    },
    {
      id: 'time_rewind',
      name: '时光倒流',
      tag: '撤回一步',
      description: '撤销上一手棋，重塑局面。无需轮到自己也能使用。',
      type: 'instant'
    }
  ];

  const boardEl = document.getElementById('board');
  const turnIndicatorEl = document.getElementById('turnIndicator');
  const winnerIndicatorEl = document.getElementById('winnerIndicator');
  const blackPlayerNameEl = document.getElementById('blackPlayerName');
  const whitePlayerNameEl = document.getElementById('whitePlayerName');
  const blackPlayerCardEl = document.getElementById('blackPlayerCard');
  const whitePlayerCardEl = document.getElementById('whitePlayerCard');
  const roomIdDisplayEl = document.getElementById('roomIdDisplay');
  const roleDisplayEl = document.getElementById('roleDisplay');
  const copyRoomBtn = document.getElementById('copyRoomBtn');
  const logListEl = document.getElementById('logList');
  const skillsContainerEl = document.getElementById('skillsContainer');
  const skillTemplate = document.getElementById('skillCardTemplate');

  const toastEl = document.createElement('div');
  toastEl.className = 'toast';
  document.body.appendChild(toastEl);

  const cells = [];
  const skillButtons = new Map();
  const logMessages = [];

  let joinInfo = null;
  let gameState = null;
  let selectedSkill = null;
  let eventSource = null;
  let toastTimer = null;
  let connectionLostNotified = false;

  function initBoard() {
    boardEl.innerHTML = '';
    for (let y = 0; y < BOARD_SIZE; y += 1) {
      const row = [];
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cell disabled';
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        cell.disabled = true;
        row.push(cell);
        boardEl.appendChild(cell);
      }
      cells.push(row);
    }

    boardEl.addEventListener('click', handleBoardClick);
  }

  function buildSkillPanel() {
    skillsContainerEl.innerHTML = '';
    SKILLS.forEach((skill) => {
      const fragment = document.importNode(skillTemplate.content, true);
      const button = fragment.querySelector('.skill-card');
      button.dataset.skillId = skill.id;
      fragment.querySelector('.skill-name').textContent = skill.name;
      fragment.querySelector('.skill-tag').textContent = skill.tag;
      fragment.querySelector('.skill-desc').textContent = skill.description;
      skillsContainerEl.appendChild(fragment);
      skillButtons.set(skill.id, skillsContainerEl.lastElementChild);
    });

    skillButtons.forEach((button, skillId) => {
      button.addEventListener('click', () => {
        const skill = SKILLS.find((item) => item.id === skillId);
        if (skill) {
          handleSkillClick(skill);
        }
      });
    });
  }

  function showToast(message, tone = 'info') {
    if (!message) return;
    toastEl.textContent = message;
    toastEl.classList.remove('error', 'success');
    if (tone === 'error') {
      toastEl.classList.add('error');
    } else if (tone === 'success') {
      toastEl.classList.add('success');
    }
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2400);
  }

  function pushLog(message) {
    if (!message) return;
    const time = new Date();
    const stamp = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    logMessages.push(`[${stamp}] ${message}`);
    if (logMessages.length > 60) {
      logMessages.shift();
    }
    renderLog();
  }

  function renderLog() {
    logListEl.innerHTML = '';
    for (let i = logMessages.length - 1; i >= 0; i -= 1) {
      const li = document.createElement('li');
      li.textContent = logMessages[i];
      logListEl.appendChild(li);
    }
  }

  function clearSkillSelection() {
    if (selectedSkill) {
      const prev = skillButtons.get(selectedSkill);
      if (prev) {
        prev.classList.remove('selected');
      }
    }
    selectedSkill = null;
    updateBoardMode();
  }

  function setSkillSelection(skillId) {
    if (selectedSkill === skillId) {
      clearSkillSelection();
      return;
    }
    clearSkillSelection();
    selectedSkill = skillId;
    const button = skillButtons.get(skillId);
    if (button) {
      button.classList.add('selected');
    }
    updateBoardMode();
  }

  function updateBoardMode() {
    const isStarPick = selectedSkill === 'star_pick';
    boardEl.classList.toggle('star-pick-mode', isStarPick);
    boardEl.classList.toggle('target-white', isStarPick && joinInfo?.color === 'black');
    boardEl.classList.toggle('target-black', isStarPick && joinInfo?.color === 'white');
  }

  function renderBoard() {
    if (!gameState) return;
    let lastMove = null;
    for (let i = gameState.history.length - 1; i >= 0; i -= 1) {
      const action = gameState.history[i];
      if (action.type === 'move') {
        lastMove = action;
        break;
      }
    }

    const isSpectator = joinInfo?.color !== 'black' && joinInfo?.color !== 'white';
    const hasWinner = Boolean(gameState.winner);
    const isMyTurn = !isSpectator && !hasWinner && gameState.turn === joinInfo?.color;
    const isStarPick = selectedSkill === 'star_pick';
    const targetColor = joinInfo?.color === 'black' ? 'white' : 'black';

    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const cell = cells[y][x];
        const piece = gameState.board[y][x];
        cell.classList.toggle('black-piece', piece === 'black');
        cell.classList.toggle('white-piece', piece === 'white');
        cell.classList.toggle('occupied', Boolean(piece));
        cell.classList.toggle('last-move', Boolean(lastMove && lastMove.x === x && lastMove.y === y));

        let disabled = true;
        if (!isSpectator && !hasWinner) {
          if (isStarPick) {
            disabled = !(isMyTurn && piece === targetColor);
          } else {
            disabled = !(isMyTurn && !piece);
          }
        }

        cell.classList.toggle('disabled', disabled);
        cell.disabled = disabled;
      }
    }
  }

  function updatePlayers() {
    const black = gameState?.players?.black || null;
    const white = gameState?.players?.white || null;

    blackPlayerNameEl.textContent = black ? black.name : '待加入';
    whitePlayerNameEl.textContent = white ? white.name : '待加入';

    const myColor = joinInfo?.color;
    blackPlayerCardEl.classList.toggle('me', myColor === 'black');
    whitePlayerCardEl.classList.toggle('me', myColor === 'white');

    const hasWinner = Boolean(gameState?.winner);
    blackPlayerCardEl.classList.toggle('active', !hasWinner && gameState?.turn === 'black');
    whitePlayerCardEl.classList.toggle('active', !hasWinner && gameState?.turn === 'white');
  }

  function updateIndicators() {
    if (!gameState) return;
    if (gameState.winner) {
      const text = gameState.winner === 'black' ? '黑方获胜！' : '白方获胜！';
      winnerIndicatorEl.textContent = text;
      winnerIndicatorEl.classList.add('success');
      turnIndicatorEl.textContent = '对局已结束';
      turnIndicatorEl.classList.remove('active');
    } else {
      winnerIndicatorEl.textContent = '';
      winnerIndicatorEl.classList.remove('success');
      if (!gameState.players.black || !gameState.players.white) {
        turnIndicatorEl.textContent = '等待对手加入...';
        turnIndicatorEl.classList.remove('active');
      } else {
        const text = gameState.turn === 'black' ? '当前轮到：黑方' : '当前轮到：白方';
        turnIndicatorEl.textContent = text;
        turnIndicatorEl.classList.add('active');
      }
    }
  }

  function updateSkillButtons() {
    skillButtons.forEach((button, skillId) => {
      let disabled = false;
      const myColor = joinInfo?.color;
      const myData = myColor ? gameState?.players?.[myColor] : null;
      const skills = myData?.skills || {};
      const skillUsed = skills[skillId];
      const hasWinner = Boolean(gameState?.winner);
      const isMyTurn = gameState?.turn === myColor;
      const isSpectator = myColor !== 'black' && myColor !== 'white';

      if (isSpectator || hasWinner || skillUsed) {
        disabled = true;
      } else {
        switch (skillId) {
          case 'fly':
          case 'force_skip':
          case 'star_pick':
            if (!isMyTurn) {
              disabled = true;
            }
            if (skillId === 'star_pick') {
              const targetColor = myColor === 'black' ? 'white' : 'black';
              const canRemove = gameState.board.some((row) => row.includes(targetColor));
              if (!canRemove) {
                disabled = true;
              }
            }
            break;
          case 'time_rewind':
            if (!gameState.history || gameState.history.length === 0) {
              disabled = true;
            }
            break;
          default:
            disabled = true;
        }
      }

      button.disabled = disabled;
      button.classList.toggle('disabled', disabled);
      if (disabled && selectedSkill === skillId) {
        clearSkillSelection();
      }
    });
  }

  function updateState(state) {
    gameState = state;
    renderBoard();
    updatePlayers();
    updateIndicators();
    updateSkillButtons();
  }

  async function postJSON(path, payload) {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      let message = '请求失败';
      try {
        const data = await response.json();
        if (data && data.error) {
          message = data.error;
        }
      } catch (error) {
        // ignore
      }
      throw new Error(message);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  async function placeStone(x, y) {
    if (!joinInfo) return;
    const payload = {
      roomId: joinInfo.roomId,
      playerId: joinInfo.playerId,
      x,
      y
    };
    if (selectedSkill === 'fly') {
      payload.skillId = 'fly';
    }
    try {
      await postJSON('/api/move', payload);
      if (selectedSkill === 'fly') {
        clearSkillSelection();
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function useSkill(skillId, extraPayload = {}) {
    if (!joinInfo) return;
    try {
      await postJSON('/api/skill', {
        roomId: joinInfo.roomId,
        playerId: joinInfo.playerId,
        skillId,
        ...extraPayload
      });
      if (skillId === 'star_pick') {
        clearSkillSelection();
      }
      if (skillId === 'force_skip') {
        showToast('强制上门已施放，对手下回合将被跳过。', 'success');
      }
      if (skillId === 'time_rewind') {
        showToast('已撤销上一手棋。', 'success');
      }
    } catch (error) {
      showToast(error.message, 'error');
      throw error;
    }
  }

  function handleBoardClick(event) {
    const target = event.target.closest('.cell');
    if (!target || target.disabled) return;
    const x = Number(target.dataset.x);
    const y = Number(target.dataset.y);
    if (Number.isNaN(x) || Number.isNaN(y)) return;

    if (selectedSkill === 'star_pick') {
      useSkill('star_pick', { target: { x, y } }).catch(() => {});
      return;
    }

    placeStone(x, y);
  }

  function handleSkillClick(skill) {
    const button = skillButtons.get(skill.id);
    if (!button || button.disabled) return;

    switch (skill.id) {
      case 'fly':
        setSkillSelection('fly');
        showToast('飞步走石已准备，落子后仍是你的回合。');
        break;
      case 'force_skip':
        useSkill('force_skip').catch(() => {});
        break;
      case 'star_pick':
        setSkillSelection('star_pick');
        showToast('请选择对手的一枚棋子发动拾空摘星。');
        break;
      case 'time_rewind': {
        const confirmUse = window.confirm('确认使用时光倒流，撤回上一手棋吗？');
        if (confirmUse) {
          useSkill('time_rewind').catch(() => {});
        }
        break;
      }
      default:
        break;
    }
  }

  function setupEventStream() {
    if (!joinInfo) return;
    if (eventSource) {
      eventSource.close();
    }
    const params = new URLSearchParams({
      roomId: joinInfo.roomId,
      playerId: joinInfo.playerId
    });
    connectionLostNotified = false;
    eventSource = new EventSource(`/api/events?${params.toString()}`);
    eventSource.addEventListener('state', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.state) {
          updateState(payload.state);
        }
        if (payload.message) {
          pushLog(payload.message);
        }
        connectionLostNotified = false;
      } catch (error) {
        console.error('无法解析事件', error);
      }
    });
    eventSource.onerror = () => {
      if (!connectionLostNotified) {
        showToast('与服务器的连接暂时中断，正在尝试重连...', 'error');
        connectionLostNotified = true;
      }
    };
  }

  async function joinGame() {
    const params = new URLSearchParams(window.location.search);
    const existingRoomId = params.get('room');
    let playerName = localStorage.getItem('gomoku_player_name') || '';
    if (!playerName) {
      playerName = window.prompt('请输入你的昵称', '玩家');
      if (playerName) {
        localStorage.setItem('gomoku_player_name', playerName);
      } else {
        playerName = '玩家';
      }
    }

    try {
      const data = await postJSON('/api/join', {
        roomId: existingRoomId || undefined,
        name: playerName
      });
      joinInfo = {
        roomId: data.roomId,
        playerId: data.playerId,
        color: data.color,
        name: playerName
      };

      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('room', data.roomId);
      window.history.replaceState({}, '', newUrl);

      roomIdDisplayEl.textContent = data.roomId;
      roleDisplayEl.textContent =
        data.color === 'black' ? '黑方' : data.color === 'white' ? '白方' : '观战者';

      if (data.state) {
        updateState(data.state);
      }
      pushLog(`${playerName} 加入了房间`);
      setupEventStream();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function setupCopyButton() {
    copyRoomBtn.addEventListener('click', async () => {
      if (!joinInfo) return;
      try {
        await navigator.clipboard.writeText(joinInfo.roomId);
        showToast('房号已复制，快去邀请好友吧！', 'success');
      } catch (error) {
        showToast('复制失败，请手动复制房间号。', 'error');
      }
    });
  }

  initBoard();
  buildSkillPanel();
  setupCopyButton();
  joinGame();
})();
