// ════════════════════════════════════════════════════════
//  리그전 경기 관리 — 공통 모듈 (Firebase 버전)
//  · 기존 Code.gs의 계산 로직(대진표·순위·점수 처리)을 그대로 옮겨 왔습니다.
//  · index.html(교사용) / student.html(학생용) / import.html(가져오기)이 함께 씁니다.
// ════════════════════════════════════════════════════════
var LG = (function () {
  var LG = {};

  // ── Firestore 위치 (다른 웹앱과 섞이지 않도록 league_ 로 시작) ──
  LG.COL_TEACHERS = "league_teachers";   // 선생님 목록
  LG.COL_LEAGUES  = "league_leagues";    // 수업(리그) — 하위 컬렉션 matches 에 경기
  LG.DOC_ADMIN    = "league_config/admin";

  // ── 로그인용 내부 이메일 (선생님은 ID+비밀번호만 입력, 이메일은 앱이 알아서 만듦) ──
  LG.EMAIL_DOMAIN = "league.pe-apps.app";
  LG.ADMIN_EMAIL  = "admin.master@" + LG.EMAIL_DOMAIN;  // '.'이 들어 있어 선생님 ID와 겹치지 않음
  LG.emailFor = function (teacherId) { return String(teacherId).toLowerCase() + "@" + LG.EMAIL_DOMAIN; };
  LG.TEACHER_ID_RE = /^[a-z0-9_-]{2,30}$/;

  // ── 단체전 방식 정의 (Code.gs 그대로) ──
  LG.TEAM_FORMATS = {
    "2b1s": { label: "2단1복 (단-복-단)", games: [
      { type: "단식", label: "1단식" }, { type: "복식", label: "복식" }, { type: "단식", label: "2단식" }
    ]},
    "3s": { label: "3단식", games: [
      { type: "단식", label: "1단식" }, { type: "단식", label: "2단식" }, { type: "단식", label: "3단식" }
    ]},
    "5s": { label: "5단식", games: [
      { type: "단식", label: "1단식" }, { type: "단식", label: "2단식" }, { type: "단식", label: "3단식" },
      { type: "단식", label: "4단식" }, { type: "단식", label: "5단식" }
    ]}
  };

  // ──────────────────────────────────────
  //  Firebase 초기화
  // ──────────────────────────────────────
  LG.configOk = function () {
    var c = window.FIREBASE_CONFIG || {};
    return !!(c.apiKey && c.projectId && String(c.apiKey).indexOf("여기에") !== 0);
  };

  LG.init = function () {
    if (!LG.configOk()) {
      var bar = document.createElement("div");
      bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:10000;background:#C8102E;color:white;" +
        "padding:12px 16px;font-weight:800;font-size:0.85em;text-align:center;line-height:1.5;";
      bar.innerHTML = "⚠️ Firebase 설정이 비어 있어요.<br>config.js 파일에 Firebase 콘솔의 설정값을 붙여넣어 주세요.";
      document.body.appendChild(bar);
      return false;
    }
    if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
    LG.auth = firebase.auth();
    LG.db   = firebase.firestore();
    LG.FV   = firebase.firestore.FieldValue;
    // 탭(창)을 닫으면 자동 로그아웃 — 기존처럼 들어올 때마다 비밀번호 입력
    try { LG.auth.setPersistence(firebase.auth.Auth.Persistence.SESSION); } catch (e) {}
    return true;
  };

  LG.teachersCol = function () { return LG.db.collection(LG.COL_TEACHERS); };
  LG.leaguesCol  = function () { return LG.db.collection(LG.COL_LEAGUES); };
  LG.leagueRef   = function (id) { return LG.leaguesCol().doc(id); };
  LG.matchesCol  = function (id) { return LG.leagueRef(id).collection("matches"); };
  LG.adminRef    = function () { return LG.db.doc(LG.DOC_ADMIN); };
  LG.matchDocId  = function (no) { var s = String(no); while (s.length < 4) s = "0" + s; return "m" + s; };

  // 다른 계정을 만들 때 지금 로그인(관리자)이 풀리지 않도록 보조 앱 사용
  LG.createAuthUser = function (email, password) {
    var sec = firebase.apps.find(function (a) { return a.name === "secondary"; }) ||
              firebase.initializeApp(window.FIREBASE_CONFIG, "secondary");
    var secAuth = sec.auth();
    return secAuth.createUserWithEmailAndPassword(email, password).then(function (cred) {
      var uid = cred.user.uid;
      return secAuth.signOut().then(function () { return uid; });
    });
  };

  // 로그인 오류 → 한국어 메시지
  LG.authErrorMsg = function (e) {
    var c = (e && e.code) || "";
    if (c === "auth/wrong-password" || c === "auth/invalid-credential" || c === "auth/invalid-login-credentials" ||
        c === "auth/user-not-found" || c === "auth/invalid-email")
      return "비밀번호가 올바르지 않습니다.";
    if (c === "auth/too-many-requests") return "시도가 너무 많아요. 잠시 후 다시 시도해 주세요.";
    if (c === "auth/network-request-failed") return "인터넷 연결을 확인해 주세요.";
    if (c === "auth/operation-not-allowed") return "Firebase 콘솔에서 '이메일/비밀번호' 로그인을 사용 설정해 주세요.";
    if (c === "auth/weak-password") return "비밀번호는 6자 이상이어야 합니다.";
    if (c === "auth/email-already-in-use") return "이미 사용 중인 ID입니다.";
    if (c === "permission-denied") return "권한이 없습니다. (보안 규칙을 확인해 주세요)";
    return (e && e.message) ? e.message : String(e);
  };

  // 여러 건 쓰기를 500개 제한에 맞춰 나눠 실행
  //  ops: [{ op:"set"|"update"|"delete", ref, data }]
  LG.commitOps = function (ops, onProgress) {
    var chunks = [];
    for (var i = 0; i < ops.length; i += 400) chunks.push(ops.slice(i, i + 400));
    var done = 0;
    return chunks.reduce(function (p, chunk) {
      return p.then(function () {
        var b = LG.db.batch();
        chunk.forEach(function (o) {
          if (o.op === "set") b.set(o.ref, o.data);
          else if (o.op === "update") b.update(o.ref, o.data);
          else if (o.op === "delete") b.delete(o.ref);
        });
        return b.commit().then(function () { done += chunk.length; if (onProgress) onProgress(done, ops.length); });
      });
    }, Promise.resolve());
  };

  // ──────────────────────────────────────
  //  대진표 (Code.gs generateSchedule 그대로)
  // ──────────────────────────────────────
  LG.generateSchedule = function (players) {
    var list = players.slice();
    if (list.length % 2 !== 0) list.push("BYE");
    var m = list.length, half = m / 2;
    var rounds = [];
    for (var r = 0; r < m - 1; r++) {
      var roundMatches = [];
      for (var i = 0; i < half; i++) {
        var p1 = list[i], p2 = list[m - 1 - i];
        if (p1 !== "BYE" && p2 !== "BYE") roundMatches.push({ player1: p1, player2: p2 });
      }
      rounds.push(roundMatches);
      var fixed = list[0], rest = list.slice(1);
      list = [fixed].concat([rest[rest.length - 1]].concat(rest.slice(0, rest.length - 1)));
    }
    var ordered = [], lastPlayers = {};
    for (var ri = 0; ri < rounds.length; ri++) {
      var remaining = rounds[ri].slice(), roundOrdered = [];
      while (remaining.length > 0) {
        var noConflict = [], conflict = [];
        for (var k = 0; k < remaining.length; k++) {
          var mm = remaining[k];
          if (!lastPlayers[mm.player1] && !lastPlayers[mm.player2]) noConflict.push(k); else conflict.push(k);
        }
        var chosenIdx = noConflict.length > 0 ? noConflict[0] : conflict[0];
        var chosen = remaining[chosenIdx];
        roundOrdered.push(chosen);
        lastPlayers = {}; lastPlayers[chosen.player1] = true; lastPlayers[chosen.player2] = true;
        remaining.splice(chosenIdx, 1);
      }
      ordered = ordered.concat(roundOrdered);
    }
    return ordered.map(function (match, idx) {
      return { matchNo: idx + 1, player1: match.player1, player2: match.player2,
               score1: "", score2: "", status: "대기", result: "" };
    });
  };

  // 단체전 경기 문서 만들기 (initTeamLeague 그대로)
  LG.buildTeamMatches = function (teamNames, formatKey) {
    if (!LG.TEAM_FORMATS[formatKey]) formatKey = "2b1s";
    var fmtDef = LG.TEAM_FORMATS[formatKey];
    var winsNeeded = Math.ceil((fmtDef.games.length + 1) / 2);
    return LG.generateSchedule(teamNames).map(function (m) {
      return {
        matchNo: m.matchNo, team1: m.player1, team2: m.player2,
        progress: "0:0", result: "", status: "대기",
        games: fmtDef.games.map(function (g) {
          return { type: g.type, label: g.label, score1: "", score2: "", status: "대기", winner: "" };
        }),
        winsNeeded: winsNeeded, team1Wins: 0, team2Wins: 0
      };
    });
  };

  // 중간 선수 추가 (addPlayersToLeague 그대로) — 새로 만들 경기 목록을 돌려줌
  LG.buildAddedMatches = function (schedule, newPlayerNames) {
    var existingPlayers = {}, maxMatchNo = 0, lastMatch = null;
    schedule.forEach(function (row) {
      if (row.matchNo > maxMatchNo) { maxMatchNo = row.matchNo; lastMatch = row; }
      existingPlayers[String(row.player1).trim()] = true;
      existingPlayers[String(row.player2).trim()] = true;
    });
    var trimmed = newPlayerNames.map(function (n) { return n.trim(); });
    var duplicates = trimmed.filter(function (n) { return existingPlayers[n]; });
    if (duplicates.length > 0) return { ok: false, error: "이미 존재하는 선수입니다: " + duplicates.join(", ") };
    var allPlayers = Object.keys(existingPlayers).filter(function (p) { return p; });
    var newPairs = [];
    trimmed.forEach(function (np) { allPlayers.forEach(function (ep) { newPairs.push({ player1: np, player2: ep }); }); });
    for (var i = 0; i < trimmed.length; i++)
      for (var j = i + 1; j < trimmed.length; j++) newPairs.push({ player1: trimmed[i], player2: trimmed[j] });

    var lastPlayerSet = {};
    if (lastMatch) { lastPlayerSet[String(lastMatch.player1).trim()] = true; lastPlayerSet[String(lastMatch.player2).trim()] = true; }
    var ordered = [], remaining = newPairs.slice();
    while (remaining.length > 0) {
      var noConflict = remaining.filter(function (m) { return !lastPlayerSet[m.player1] && !lastPlayerSet[m.player2]; });
      var chosen = noConflict.length > 0 ? noConflict[0] : remaining[0];
      ordered.push(chosen);
      lastPlayerSet = {}; lastPlayerSet[chosen.player1] = true; lastPlayerSet[chosen.player2] = true;
      remaining.splice(remaining.indexOf(chosen), 1);
    }
    var matches = ordered.map(function (m, k) {
      return { matchNo: maxMatchNo + k + 1, player1: m.player1, player2: m.player2,
               score1: "", score2: "", status: "대기", result: "" };
    });
    return { ok: true, matches: matches, newPlayers: trimmed };
  };

  // ──────────────────────────────────────
  //  점수 처리 (submitScore / 단체전 함수들 그대로)
  // ──────────────────────────────────────
  LG.calcIndividualScore = function (match, sets, winsNeeded) {
    var p1 = String(match.player1), p2 = String(match.player2);
    var p1sets = 0, p2sets = 0, setDetails = [];
    sets.forEach(function (s) {
      var s1 = Number(s[0]), s2 = Number(s[1]);
      if (s1 > s2) p1sets++; else if (s2 > s1) p2sets++;
      setDetails.push(s1 + ":" + s2);
    });
    winsNeeded = Number(winsNeeded) || 1;
    var decided = (winsNeeded <= 1) ? true : (p1sets >= winsNeeded || p2sets >= winsNeeded);
    var result, status;
    if (!decided) { result = ""; status = "경기중"; }
    else {
      status = "완료";
      if (p1sets > p2sets) result = p1 + " 승 (" + setDetails.join(", ") + ")";
      else if (p2sets > p1sets) result = p2 + " 승 (" + setDetails.join(", ") + ")";
      else result = "무승부";
    }
    return {
      score1: sets.map(function (s) { return s[0]; }).join("-"),
      score2: sets.map(function (s) { return s[1]; }).join("-"),
      result: result, status: status
    };
  };

  function tally(games) {
    return {
      t1: games.filter(function (x) { return x.winner === "team1"; }).length,
      t2: games.filter(function (x) { return x.winner === "team2"; }).length
    };
  }

  // scores: [{gameIndex, score1, score2}]  → 갱신할 필드 (오류면 {error})
  LG.applyTeamScores = function (match, scores) {
    var games = (match.games || []).map(function (g) { return Object.assign({}, g); });
    if (!games.length) return { error: "세부 경기를 찾을 수 없습니다." };
    if (!scores || !scores.length) return { error: "입력할 점수가 없습니다." };
    for (var k = 0; k < scores.length; k++) {
      var g = games[Number(scores[k].gameIndex)];
      if (!g) continue;
      var s1 = Number(scores[k].score1), s2 = Number(scores[k].score2);
      if (isNaN(s1) || isNaN(s2) || s1 < 0 || s2 < 0) return { error: (g.label || "경기") + " 점수가 올바르지 않습니다." };
      if (s1 === s2) return { error: (g.label || "경기") + "는 무승부를 입력할 수 없습니다." };
      g.score1 = s1; g.score2 = s2; g.status = "완료"; g.winner = s1 > s2 ? "team1" : "team2";
    }
    var t = tally(games);
    var allPlayed = games.every(function (x) { return x.status === "완료"; });
    var status, result;
    if (allPlayed) {
      status = "완료";
      result = (t.t1 > t.t2 ? match.team1 : match.team2) + " 승 (" + t.t1 + ":" + t.t2 + ")";
    } else { status = "경기중"; result = ""; }
    return { games: games, team1Wins: t.t1, team2Wins: t.t2, progress: t.t1 + ":" + t.t2, result: result, status: status };
  };

  LG.resetTeamGame = function (match, gameIndex) {
    var games = (match.games || []).map(function (g) { return Object.assign({}, g); });
    var old = games[gameIndex];
    if (!old) return { error: "세부 경기를 찾을 수 없습니다." };
    games[gameIndex] = { type: old.type, label: old.label, score1: "", score2: "", status: "대기", winner: "" };
    var t = tally(games);
    var anyDone = games.some(function (x) { return x.status === "완료"; });
    var allPlayed = games.every(function (x) { return x.status === "완료"; });
    return { games: games, team1Wins: t.t1, team2Wins: t.t2, progress: t.t1 + ":" + t.t2, result: "",
             status: allPlayed ? "완료" : (anyDone ? "경기중" : "대기") };
  };

  LG.resetTeamTie = function (match) {
    return {
      games: (match.games || []).map(function (g) {
        return { type: g.type, label: g.label, score1: "", score2: "", status: "대기", winner: "" };
      }),
      team1Wins: 0, team2Wins: 0, progress: "0:0", result: "", status: "대기"
    };
  };

  // ──────────────────────────────────────
  //  순위 계산 (computeRankings / computeTeamRankings 그대로)
  // ──────────────────────────────────────
  LG.computeRankings = function (schedule) {
    var stats = {};
    schedule.forEach(function (row) {
      if (String(row.status).trim() !== "완료") return;
      var p1 = String(row.player1).trim(), p2 = String(row.player2).trim();
      var sc1 = String(row.score1 == null ? "" : row.score1).trim(), sc2 = String(row.score2 == null ? "" : row.score2).trim();
      if (!p1 || !p2) return;
      if (!stats[p1]) stats[p1] = { w: 0, d: 0, l: 0, scored: 0, conceded: 0, pts: 0, games: 0 };
      if (!stats[p2]) stats[p2] = { w: 0, d: 0, l: 0, scored: 0, conceded: 0, pts: 0, games: 0 };
      stats[p1].games++; stats[p2].games++;
      var s1parts = sc1.indexOf("-") >= 0 ? sc1.split("-") : [sc1];
      var s2parts = sc2.indexOf("-") >= 0 ? sc2.split("-") : [sc2];
      var p1sets = 0, p2sets = 0, totalS1 = 0, totalS2 = 0;
      var setCount = Math.max(s1parts.length, s2parts.length);
      for (var si = 0; si < setCount; si++) {
        var sv1 = Number(s1parts[si] || 0), sv2 = Number(s2parts[si] || 0);
        if (!isNaN(sv1) && !isNaN(sv2)) {
          totalS1 += sv1; totalS2 += sv2;
          if (sv1 > sv2) p1sets++; else if (sv2 > sv1) p2sets++;
        }
      }
      stats[p1].scored += totalS1; stats[p1].conceded += totalS2;
      stats[p2].scored += totalS2; stats[p2].conceded += totalS1;
      if (p1sets > p2sets) { stats[p1].w++; stats[p1].pts += 3; stats[p2].l++; }
      else if (p2sets > p1sets) { stats[p2].w++; stats[p2].pts += 3; stats[p1].l++; }
      else {
        var n1 = Number(sc1), n2 = Number(sc2);
        if (!isNaN(n1) && !isNaN(n2)) {
          if (n1 > n2) { stats[p1].w++; stats[p1].pts += 3; stats[p2].l++; }
          else if (n2 > n1) { stats[p2].w++; stats[p2].pts += 3; stats[p1].l++; }
          else { stats[p1].d++; stats[p1].pts++; stats[p2].d++; stats[p2].pts++; }
        }
      }
    });
    var list = Object.keys(stats).map(function (name) {
      var s = stats[name];
      return { name: name, games: s.games, w: s.w, d: s.d, l: s.l, scored: s.scored, conceded: s.conceded,
               diff: s.scored - s.conceded, pts: s.pts };
    });
    list.sort(function (a, b) {
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.diff !== a.diff) return b.diff - a.diff;
      return b.scored - a.scored;
    });
    var rank = 1;
    list.forEach(function (p, i) {
      if (i > 0) { var prev = list[i - 1]; if (p.pts !== prev.pts || p.diff !== prev.diff || p.scored !== prev.scored) rank = i + 1; }
      p.rank = rank;
    });
    return list;
  };

  LG.computeTeamRankings = function (schedule) {
    var stats = {};
    schedule.forEach(function (row) {
      if (String(row.status).trim() !== "완료") return;
      var t1 = String(row.team1).trim(), t2 = String(row.team2).trim();
      if (!t1 || !t2) return;
      var w1 = Number(row.team1Wins) || 0, w2 = Number(row.team2Wins) || 0;
      if (!stats[t1]) stats[t1] = { w: 0, l: 0, gWin: 0, gLose: 0, pts: 0, games: 0 };
      if (!stats[t2]) stats[t2] = { w: 0, l: 0, gWin: 0, gLose: 0, pts: 0, games: 0 };
      stats[t1].games++; stats[t2].games++;
      stats[t1].gWin += w1; stats[t1].gLose += w2;
      stats[t2].gWin += w2; stats[t2].gLose += w1;
      if (w1 > w2) { stats[t1].w++; stats[t1].pts += 3; stats[t2].l++; }
      else { stats[t2].w++; stats[t2].pts += 3; stats[t1].l++; }
    });
    var list = Object.keys(stats).map(function (name) {
      var s = stats[name];
      return { name: name, games: s.games, w: s.w, l: s.l, diff: s.gWin - s.gLose, pts: s.pts };
    });
    list.sort(function (a, b) {
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.diff !== a.diff) return b.diff - a.diff;
      return 0;
    });
    var rank = 1;
    list.forEach(function (p, i) {
      if (i > 0) { var prev = list[i - 1]; if (p.pts !== prev.pts || p.diff !== prev.diff) rank = i + 1; }
      p.rank = rank;
    });
    return list;
  };

  // 학생 화면용 요약 (수업 문서 1개만 읽으면 되도록 저장해 둠 → 사용량 절약)
  LG.computeStats = function (mode, schedule) {
    var rankings = mode === "team" ? LG.computeTeamRankings(schedule) : LG.computeRankings(schedule);
    var done = schedule.filter(function (m) { return m.status === "완료"; }).length;
    return { rankings: rankings, done: done, total: schedule.length };
  };

  LG.sameStats = function (a, b) {
    if (!a || !b) return false;
    return JSON.stringify({ r: a.rankings, d: a.done, t: a.total }) === JSON.stringify({ r: b.rankings, d: b.done, t: b.total });
  };

  // ──────────────────────────────────────
  //  유틸
  // ──────────────────────────────────────
  LG.esc = function (s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  LG.param = function (name) {
    try { return new URLSearchParams(location.search).get(name) || ""; } catch (e) { return ""; }
  };
  LG.pageUrl = function (file) {
    var base = location.href.split("#")[0].split("?")[0];
    return base.substring(0, base.lastIndexOf("/") + 1) + file;
  };

  return LG;
})();
