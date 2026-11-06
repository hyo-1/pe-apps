// ════════════════════════════════════════════════════════
//  기존 구글 시트(.xlsx) → 리그전 데이터 변환기
//  · 시트 이름이 "선생님ID_수업명_(team|individual)_명단/경기결과/순위" 형태인 것을 한 수업으로 묶어요.
//  · 시트 이름이 31자에서 잘려 있어도(예: "_경기결") 시트 첫 줄 제목으로 종류를 알아봐요.
//  · 브라우저(import.html)와 Node(점검용) 양쪽에서 쓸 수 있어요.
// ════════════════════════════════════════════════════════
var LGImport = (function () {
  var L = {};

  function str(v) { return v == null ? "" : String(v).trim(); }

  // 점수 칸: 숫자는 문자열로 (3.0 → "3"), 빈 칸은 ""
  function normScore(v) {
    if (v == null || v === "") return "";
    if (typeof v === "number") return String(v);
    return String(v).trim();
  }

  function normStatus(v) {
    var s = str(v);
    return (s === "완료" || s === "경기중" || s === "대기") ? s : "대기";
  }

  function isEmptyRows(rows) {
    return !rows.some(function (r) { return r.some(function (c) { return str(c) !== ""; }); });
  }

  // 시트 첫 줄(제목)로 종류 판별
  function classify(rows) {
    var h = (rows[0] || []).map(str);
    if (h[0] === "경기번호") return "results";
    if (h[0] === "순위") return "ranking";
    if (h[0] === "번호" || h[0] === "이름") return "roster";
    return "";
  }

  // 시트 이름 끝의 _명단 / _경기결과 / _순위 (잘린 형태 포함) 떼어내기
  function groupKey(name) {
    return name.replace(/_(?:경기결과|경기결|경기|경|명단|명|순위|순)$/, "");
  }

  // "kdodo112_9.19. 탁구연수_team" → 선생님ID / 수업명 / 방식
  function parseKey(key) {
    var teacherId = "", rest = key, modeHint = "";
    var i = key.indexOf("_");
    if (i > 0) { teacherId = key.substring(0, i); rest = key.substring(i + 1); }
    var m = rest.match(/^(.*)_(team|individual)$/);
    if (m) { rest = m[1]; modeHint = m[2]; }
    return { teacherId: teacherId, name: rest || key, modeHint: modeHint };
  }

  function teamFormatOf(matches) {
    for (var i = 0; i < matches.length; i++) {
      var g = matches[i].games || [];
      if (g.length >= 5) return "5s";
      if (g.some(function (x) { return x.type === "복식"; })) return "2b1s";
      if (g.length === 3) return "3s";
    }
    return "2b1s";
  }

  // 점수에 세트 점수("11-9-11")가 있으면 3판2승/5판3승으로 추정
  function indFormatOf(matches) {
    var maxParts = 1;
    matches.forEach(function (m) {
      var p = String(m.score1 || "").split("-").length;
      if (p > maxParts) maxParts = p;
    });
    return maxParts >= 4 ? "bo5" : maxParts >= 2 ? "bo3" : "1set";
  }

  var DEFAULT_TEAM_GAMES = {
    "2b1s": [["단식", "1단식"], ["복식", "복식"], ["단식", "2단식"]],
    "3s":   [["단식", "1단식"], ["단식", "2단식"], ["단식", "3단식"]],
    "5s":   [["단식", "1단식"], ["단식", "2단식"], ["단식", "3단식"], ["단식", "4단식"], ["단식", "5단식"]]
  };

  function parseIndividualMatches(rows, warnings) {
    var out = [], bigScore = 0;
    rows.slice(1).forEach(function (r) {
      if (str(r[0]) === "") return;
      var no = Number(r[0]);
      if (isNaN(no)) return;
      var m = {
        matchNo: no, player1: str(r[1]), player2: str(r[4]),
        score1: normScore(r[2]), score2: normScore(r[3]),
        result: str(r[5]), status: normStatus(r[6])
      };
      if (!m.player1 || !m.player2) return;
      if (m.status === "완료" && (Number(m.score1) >= 100 || Number(m.score2) >= 100)) bigScore++;
      out.push(m);
    });
    if (bigScore) warnings.push("점수가 100 이상인 경기가 " + bigScore + "개 있어요. 시트가 점수를 날짜로 바꿨을 수 있으니 가져온 뒤 확인해 주세요.");
    return out;
  }

  function parseTeamMatches(rows, warnings) {
    var out = [], bad = 0;
    rows.slice(1).forEach(function (r) {
      if (str(r[0]) === "") return;
      var no = Number(r[0]);
      if (isNaN(no)) return;
      var t1 = str(r[1]), t2 = str(r[2]);
      if (!t1 || !t2) return;
      var detail = null;
      try { detail = JSON.parse(String(r[6])); } catch (e) {}
      var m = { matchNo: no, team1: t1, team2: t2, progress: str(r[3]) || "0:0", result: str(r[4]), status: normStatus(r[5]) };
      if (detail && detail.games && detail.games.length) {
        m.games = detail.games.map(function (g) {
          return { type: g.type || "단식", label: g.label || "", score1: g.score1 == null ? "" : g.score1,
                   score2: g.score2 == null ? "" : g.score2, status: g.status || "대기", winner: g.winner || "" };
        });
        m.winsNeeded = Number(detail.winsNeeded) || Math.ceil((m.games.length + 1) / 2);
        m.team1Wins = Number(detail.team1Wins) || 0;
        m.team2Wins = Number(detail.team2Wins) || 0;
      } else {
        // 세부 기록(상세 열)이 없거나 깨진 경우: 진행상황("2:1")으로 승수만 살리고 세부 경기는 비워 둠
        bad++;
        var pm = m.progress.match(/^(\d+)\s*:\s*(\d+)$/);
        m.games = DEFAULT_TEAM_GAMES["2b1s"].map(function (g) {
          return { type: g[0], label: g[1], score1: "", score2: "", status: "대기", winner: "" };
        });
        m.winsNeeded = 2;
        m.team1Wins = pm ? Number(pm[1]) : 0;
        m.team2Wins = pm ? Number(pm[2]) : 0;
      }
      out.push(m);
    });
    if (bad) warnings.push("세부 기록(상세 열)을 읽지 못한 경기가 " + bad + "개 있어요. 승패 수만 가져왔어요.");
    return out;
  }

  function rosterFrom(rows) {
    var colIdx = 0;
    var ncols = Math.max.apply(null, rows.map(function (r) { return r.length; }).concat([1]));
    if (ncols >= 2) colIdx = 1;   // 번호+이름 두 칸 구조면 B열 (Code.gs getRoster와 같은 규칙)
    var names = [];
    rows.slice(1).forEach(function (r) {
      var n = str(r[colIdx]);
      if (n.length > 0 && isNaN(Number(n)) && names.indexOf(n) < 0) names.push(n);
    });
    return names;
  }

  // wb: XLSX.read 결과, XLSX: SheetJS
  // 반환: { groups: [...], skipped: [{sheet, reason}] }
  L.parseWorkbook = function (wb, XLSX) {
    var groups = {}, order = [], skipped = [];
    wb.SheetNames.forEach(function (sn) {
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: "", raw: true });
      if (isEmptyRows(rows)) { skipped.push({ sheet: sn, reason: "비어 있는 시트" }); return; }
      var type = classify(rows);
      if (!type) { skipped.push({ sheet: sn, reason: "형식을 알 수 없는 시트" }); return; }
      var key = groupKey(sn);
      if (!groups[key]) { groups[key] = { key: key, sheets: [] }; order.push(key); }
      var g = groups[key];
      if (g[type]) { skipped.push({ sheet: sn, reason: "같은 수업의 " + type + " 시트가 이미 있어요" }); return; }
      g[type] = rows;
      g.sheets.push(sn);
    });

    var result = [];
    order.forEach(function (key) {
      var g = groups[key];
      if (!g.results && !g.roster) {
        skipped.push({ sheet: g.sheets.join(", "), reason: "순위 시트만 있어요 (경기 기록이 없어 복원할 수 없어요)" });
        return;
      }
      var pk = parseKey(key), warnings = [];
      var isTeam;
      if (g.results) isTeam = str(g.results[0][1]) === "팀1";
      else isTeam = pk.modeHint === "team";
      var mode = isTeam ? "team" : "individual";
      var matches = g.results ? (isTeam ? parseTeamMatches(g.results, warnings) : parseIndividualMatches(g.results, warnings)) : [];
      matches.sort(function (a, b) { return a.matchNo - b.matchNo; });

      var roster = g.roster ? rosterFrom(g.roster) : [];
      if (!roster.length) {
        matches.forEach(function (m) {
          (isTeam ? [m.team1, m.team2] : [m.player1, m.player2]).forEach(function (n) { if (roster.indexOf(n) < 0) roster.push(n); });
        });
        if (roster.length) warnings.push("명단 시트가 없어서 경기 기록에서 이름을 모았어요.");
      }
      var maxRoster = isTeam ? 20 : 34;
      if (roster.length > maxRoster) warnings.push("명단이 " + roster.length + "명이에요. 앱 최대 인원(" + maxRoster + ")보다 많아서, 새로 대진표를 만들 때는 줄여야 해요.");

      var done = matches.filter(function (m) { return m.status === "완료"; }).length;
      var playing = matches.filter(function (m) { return m.status === "경기중"; }).length;
      result.push({
        key: key, id: "imp_" + key.replace(/\//g, "_"),
        sheets: g.sheets, teacherId: pk.teacherId, name: pk.name, mode: mode,
        roster: roster, matches: matches,
        matchFormat: isTeam ? "1set" : indFormatOf(matches),
        teamFormat: isTeam ? teamFormatOf(matches) : "2b1s",
        counts: { matches: matches.length, done: done, playing: playing, roster: roster.length },
        warnings: warnings,
        // 이름 규칙(선생님ID_수업명)을 따르는 시트만 처음부터 체크
        hasNamePattern: !!pk.teacherId,
        hasRankingSheet: !!g.ranking, rankingRows: g.ranking || null
      });
    });
    return { groups: result, skipped: skipped };
  };

  return L;
})();

if (typeof module !== "undefined" && module.exports) module.exports = LGImport;
