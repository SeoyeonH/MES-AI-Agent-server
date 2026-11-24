const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

const upload = multer({ dest: 'uploads/' });

// OpenAI 및 DB 초기화
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'password',
  database: process.env.PG_DATABASE || 'mes_db',
  port: process.env.PG_PORT || 5432,
});

// DB 스키마 마이그레이션 (결과 ID 형식 변경 대응)
async function migrateSchema() {
  try {
    // 1. 제약 조건 확인 및 삭제
    await pool.query('ALTER TABLE defects DROP CONSTRAINT IF EXISTS defects_result_id_fkey');
    // 2. 컬럼 타입 변경
    await pool.query('ALTER TABLE production_results ALTER COLUMN result_id TYPE VARCHAR(20)');
    await pool.query('ALTER TABLE defects ALTER COLUMN result_id TYPE VARCHAR(20)');
    // 3. 제약 조건 재설정
    await pool.query('ALTER TABLE production_results ADD CONSTRAINT production_results_pkey PRIMARY KEY (result_id)');
    await pool.query('ALTER TABLE defects ADD CONSTRAINT defects_result_id_fkey FOREIGN KEY (result_id) REFERENCES production_results(result_id)');
    console.log('Schema migration completed successfully.');
  } catch (err) {
    console.error('Migration skipped or error:', err.message);
  }
}
migrateSchema();

// KPI 및 Dashboard 데이터 API (하드코딩 제거 버전)
// 라인 상태 동기화 함수 (작업지시에 따라 lines 테이블 업데이트)
async function updateLineStatus(lineId) {
  try {
    // 1. 해당 라인에 '진행중'인 작업이 있는지 확인
    const activeWo = await pool.query("SELECT 1 FROM work_orders WHERE line_id = $1 AND status = '진행중' LIMIT 1", [lineId]);

    // 2. 해당 라인에 '대기' 중인 작업이 있는지 확인
    const pendingWo = await pool.query("SELECT 1 FROM work_orders WHERE line_id = $1 AND status = '대기' LIMIT 1", [lineId]);

    let newStatus = '정지';
    if (activeWo.rows.length > 0) {
      newStatus = '가동중';
    } else if (pendingWo.rows.length > 0) {
      newStatus = '준비중';
    }

    // 3. lines 테이블 상태 업데이트
    await pool.query('UPDATE lines SET status = $1 WHERE line_id = $2', [newStatus, lineId]);
  } catch (err) {
    console.error('updateLineStatus error:', err);
  }
}

// 작업지시 진행률 체크 및 자동 완료 처리 함수
async function checkWorkOrderCompletion(woId) {
  try {
    // 1. 작업지시의 계획 수량과 실적 수량 조회
    const woRes = await pool.query('SELECT planned_qty, actual_qty, status, line_id FROM work_orders WHERE wo_id = $1', [woId]);
    if (woRes.rows.length === 0) return;

    const { planned_qty, actual_qty, status, line_id } = woRes.rows[0];

    // 2. 진행률이 100% 이상이고 상태가 아직 '완료'가 아닌 경우
    if (actual_qty >= planned_qty && status !== '완료') {
      // 3. 작업지시 상태를 '완료'로 변경
      await pool.query("UPDATE work_orders SET status = '완료' WHERE wo_id = $1", [woId]);
      console.log(`Work order ${woId} automatically completed (Progress: ${actual_qty}/${planned_qty})`);

      // 4. 해당 라인의 상태도 다시 업데이트 (진행중인 작업이 없을 수 있으므로)
      if (line_id) {
        await updateLineStatus(line_id);
      }
    }
  } catch (err) {
    console.error('checkWorkOrderCompletion error:', err);
  }
}

// ===== MES 음성 텍스트 정규화 =====
function koreanNumToArabic(str) {
  const digits = { '일': 1, '이': 2, '삼': 3, '사': 4, '오': 5, '육': 6, '칠': 7, '팔': 8, '구': 9 }
  const mults = { '십': 10, '백': 100, '천': 1000 }
  let total = 0, cur = 0
  for (const ch of str) {
    if (digits[ch] !== undefined) { cur = digits[ch] }
    else if (mults[ch] !== undefined) { total += (cur || 1) * mults[ch]; cur = 0 }
  }
  return total + cur
}
function normalizeMESText(text) {
  let t = text
  // 1. 알파벳 제품군 교정
  t = t.replace(/에이\s*형/g, 'A형')
    .replace(/비\s*형/g, 'B형')
    .replace(/씨\s*형|시\s*형/g, 'C형')
  // 2. 라인 번호 교정
  t = t.replace(/일\s*라인/g, '1라인')
    .replace(/이\s*라인/g, '2라인')
    .replace(/삼\s*라인/g, '3라인')
  // ✅ 3. 작업번호 교정 (W5, W오, WO 등 → WO)
  t = t.replace(/W\s*[5오O]\s*[-–\s]*(\d{4})\s*[-–\s]*(\d+)/gi, 'WO-$1-$2')
  // 4. 한글 숫자 → 아라비아 숫자 (단위 앞 숫자)
  const numPattern = /([일이삼사오육칠팔구십백천]+)\s*(개|수량|장|명|번|호)/g
  t = t.replace(numPattern, (_, numStr, unit) => {
    const n = koreanNumToArabic(numStr)
    return n > 0 ? `${n}${unit}` : _
  })
  return t
}

function extractLineName(text) {
  const match = text.match(/([1-3])\s*(?:번\s*)?라인/);
  return match ? `${match[1]}라인` : null;
}

function inferRequestedStatus(text) {
  if (/(가동해줘|가동해 줘|가동|진행해줘|진행해 줘|진행시켜|진행 시작|진행\b|시작해줘|시작해 줘|시작|작업 시작|가동시켜)/.test(text)) {
    return '진행중';
  }
  if (/(중단해줘|중단해 줘|중단|멈춰|멈춰줘|대기해|대기해줘|대기|정지해줘|정지해 줘|정지)/.test(text)) {
    return '대기';
  }
  if (/(완료해줘|완료해 줘|완료해|완료|끝내줘|끝내 줘|끝내|마감해줘|마감해 줘|마감)/.test(text)) {
    return '완료';
  }
  return null;
}

function inferDeleteIntent(text) {
  return /(삭제해줘|삭제해 줘|삭제|지워줘|지워 줘|지워|없애줘|없애 줘|없애)/.test(text);
}

async function buildDeleteWorkOrderConfirm(woId) {
  const checkRes = await pool.query(
    `SELECT w.wo_id, w.product_name, l.line_name, w.status
     FROM work_orders w
     JOIN lines l ON w.line_id = l.line_id
     WHERE w.wo_id = $1`,
    [woId]
  );

  if (checkRes.rows.length === 0) {
    return {
      type: 'text',
      text: `작업번호 ${woId}는 존재하지 않는 번호입니다. 확인 후 다시 말씀해 주세요.`
    };
  }

  const workOrder = checkRes.rows[0];
  return {
    type: 'confirm',
    confirmType: 'delete',
    text: `작업지시 ${woId}번을 삭제하시겠습니까?`,
    confirmData: {
      wo_id: woId,
      woId,
      product: workOrder.product_name,
      line: workOrder.line_name,
      status: workOrder.status,
      field: '삭제',
      newValue: '삭제',
      summary: `제품: ${workOrder.product_name}, 라인: ${workOrder.line_name}, 상태: ${workOrder.status}`
    }
  };
}

async function buildLineStatusEditConfirm(lineName, status) {
  const target = await findTargetWorkOrderByLineStatus(lineName, status);
  if (target?.error === 'LINE_NOT_FOUND') {
    return {
      type: 'text',
      text: `${lineName}을 찾지 못했습니다. 라인명을 확인해 주세요.`
    };
  }
  if (!target) {
    const sourceStatus = status === '진행중' ? '대기' : status === '대기' ? '진행중' : status;
    return {
      type: 'text',
      text: `${lineName}에 ${sourceStatus} 상태 작업이 없어 변경할 대상이 없습니다.`
    };
  }

  const woId = target.wo_id;
  return {
    type: 'confirm',
    confirmType: 'edit',
    text: `${lineName}의 작업지시 ${woId} 상태를 ${status}로 변경하시겠습니까?`,
    confirmData: {
      wo_id: woId,
      woId,
      status,
      field: '상태',
      newValue: status,
      summary: `상태: ${status}`
    }
  };
}

async function findTargetWorkOrderByLineStatus(lineName, status) {
  const lineRes = await pool.query('SELECT line_id FROM lines WHERE line_name = $1', [lineName]);
  if (lineRes.rows.length === 0) return { error: 'LINE_NOT_FOUND' };

  let sourceStatus = null;
  if (status === '진행중') {
    sourceStatus = '대기';
  } else if (status === '대기') {
    sourceStatus = '진행중';
  }
  if (!sourceStatus) return null;

  const lineId = lineRes.rows[0].line_id;
  const targetRes = await pool.query(
    `SELECT wo_id
     FROM work_orders
     WHERE line_id = $1 AND status = $2
     ORDER BY created_at ASC
     LIMIT 1`,
    [lineId, sourceStatus]
  );

  if (targetRes.rows.length === 0) return null;

  return {
    line_id: lineId,
    wo_id: targetRes.rows[0].wo_id,
    sourceStatus
  };
}

// ✅ [추가] 라인별 대기 작업을 즉시 진행으로 바꾸는 헬퍼 함수
async function executeLineStatusChange(lineName, status) {
  const target = await findTargetWorkOrderByLineStatus(lineName, status);
  if (!target || target.error) return null;

  const lineId = target.line_id;
  const woId = target.wo_id;

  // DB 업데이트 수행
  await pool.query("UPDATE work_orders SET status = $1 WHERE wo_id = $2", [status, woId]);
  await updateLineStatus(lineId);

  const finalWoRes = await pool.query('SELECT product_name FROM work_orders WHERE wo_id = $1', [woId]);
  const productName = finalWoRes.rows[0]?.product_name || '제품';

  return {
    type: 'confirm',
    confirmType: 'edit',
    confirmed: true, // 즉시 완료 표시
    text: `${lineName}의 작업지시 ${woId} 상태를 ${status}로 변경했습니다.`,
    confirmData: {
      wo_id: woId,
      woId,
      productName,
      status,
      field: '상태',
      newValue: status,
      summary: `자동 실행: ${lineName} 작업 시작`
    }
  };
}

// Whisper API를 이용한 음성 텍스트 변환 (STT)
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file' })
    // 확장자 추가 (Whisper 포맷 인식)
    const newPath = req.file.path + '.webm'
    fs.renameSync(req.file.path, newPath)
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(newPath),
      model: 'whisper-1',
      language: 'ko',
      prompt: `1라인, 2라인, 3라인, A형 부품, B형 부품, C형 부품, A형 조립품, B형 조립품, C형 조립품, A형 모듈, B형 모듈, C형 모듈, 작업지시, 작업번호, 생산실적, 양품, 불량, 계획수량, WO-${new Date().getFullYear()}-001, WO-${new Date().getFullYear()}-011, WO-${new Date().getFullYear()}-012, 진행중, 대기, 완료`
    })
    fs.unlinkSync(newPath)
    // 한글/발음 오인식 교정
    const normalized = normalizeMESText(transcription.text)
    console.log(`[Whisper] 원문: "${transcription.text}" → 교정: "${normalized}"`)
    res.json({ text: normalized })
  } catch (e) {
    console.error('Transcription error:', e)
    try { fs.unlinkSync(req.file.path) } catch { }
    try { fs.unlinkSync(req.file.path + '.webm') } catch { }
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/dashboard', async (req, res) => {
  try {
    // 1. KPI 목표값 조회
    const kpiRes = await pool.query('SELECT kpi_name, target_value FROM kpi_targets');
    const kpis = {};
    kpiRes.rows.forEach(row => { kpis[row.kpi_name] = parseFloat(row.target_value); });

    // 2. 오늘 생산 및 불량 집계
    const prodRes = await pool.query(`
        SELECT 
            COALESCE(SUM(good_qty), 0) as total_good,
            COALESCE(SUM(defect_qty), 0) as total_defect
        FROM production_results 
        WHERE recorded_at >= CURRENT_DATE
    `);
    const { total_good, total_defect } = prodRes.rows[0];
    const totalProd = parseInt(total_good) + parseInt(total_defect);
    const defectRate = totalProd > 0 ? (total_defect / totalProd * 100).toFixed(1) : 0;

    // 3. 작업지시 상태별 카운트 (실시간 집계)
    const woStatsRes = await pool.query(`
        SELECT 
            COUNT(*) FILTER (WHERE status = '진행중') as active,
            COUNT(*) FILTER (WHERE status = '대기') as waiting,
            COUNT(*) FILTER (WHERE status = '완료') as done
        FROM work_orders
    `);
    const { active, waiting, done } = woStatsRes.rows[0];

    // 4. 라인 상태 조회 (작업지시 기반 실시간 상태 및 진행률 계산)
    const lineRes = await pool.query(`
        SELECT 
            l.line_name as name, 
            CASE 
                WHEN EXISTS (SELECT 1 FROM work_orders WHERE line_id = l.line_id AND status = '진행중') THEN '가동중'
                WHEN EXISTS (SELECT 1 FROM work_orders WHERE line_id = l.line_id AND status = '대기') THEN '준비중'
                ELSE '정지'
            END as status,
            COALESCE(
                LEAST(ROUND((SUM(w.actual_qty)::numeric / NULLIF(SUM(w.planned_qty), 0)) * 100, 2), 100), 
                0
            ) as progress
        FROM lines l
        LEFT JOIN work_orders w ON l.line_id = w.line_id
        GROUP BY l.line_id, l.line_name
        ORDER BY l.line_id
    `);

    const dashboardData = {
      kpis: {
        today_production: parseInt(total_good),
        today_target: kpis['DAILY_PRODUCTION_TARGET'] || 1500,
        defect_rate: parseFloat(defectRate),
        active_work_orders: parseInt(active),
        waiting_work_orders: parseInt(waiting),
        done_work_orders: parseInt(done),
        active_lines: lineRes.rows.filter(l => l.status === '가동중').length,
        utilization_rate: kpis['UTILIZATION_TARGET'] || 90.0
      },
      lines: lineRes.rows.map(l => ({
        name: l.name,
        progress: parseFloat(l.progress),
        status: l.status
      }))
    };

    res.json(dashboardData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ===== 설비 유지보수 지식 베이스 (Knowledge Base for RAG) =====
const EQUIPMENT_MANUAL = [
  {
    title: '서보 모터 과부하',
    category: '전기계통',
    symptoms: '서보 드라이버 LED 적색 점멸, 모터 정지, 모터 과열',
    cause: '부하 초과, 감속기 이상, 볼스크류 고착',
    steps: [
      '즉시 비상정지(E-STOP) 버튼을 눌러 설비를 정지시킵니다.',
      '서보 드라이버의 에러 표시를 확인합니다 (LED 점멸 패턴 확인).',
      '모터와 감속기 연결부의 과열 여부를 손등으로 확인합니다.',
      '부하를 제거한 상태에서 JOG 운전으로 모터 단독 구동을 테스트합니다.',
      '정상 작동 시 부하를 재연결하고 저속에서 시운전합니다.'
    ],
    caution: '모터 과열 시 최소 30분 냉각 후 작업하십시오. 감전 위험이 있으므로 반드시 전원 차단 후 점검하세요.',
    tags: ['서보모터', '과부하', '전기', '모터정지', '과열']
  },
  {
    title: '공압 실린더 동작 불량',
    category: '공압계통',
    symptoms: '실린더 미동작, 실린더 속도 저하, 이상 소음 발생, 공압 부족',
    cause: '공압 공급 압력 부족, 솔레노이드 밸브 고착, 실린더 패킹 마모',
    steps: [
      '메인 공압 게이지에서 공급 압력이 0.5MPa 이상인지 확인합니다.',
      '해당 솔레노이드 밸브의 수동 조작 버튼으로 작동 여부를 점검합니다.',
      '밸브 작동 시: 실린더 배관 연결부의 에어 누설을 비눗물로 점검합니다.',
      '밸브 미작동 시: 밸브 코일의 통전 상태를 멀티미터로 확인합니다.',
      '실린더 속도 조절 밸브(스피드 컨트롤러)를 조정하여 적정 속도를 설정합니다.'
    ],
    caution: '잔압이 남아있을 수 있으므로 배관 분리 시 서서히 압력을 빼고 작업하세요.',
    tags: ['공압', '실린더', '밸브', '압력부족', '소음']
  },
  {
    title: '근접 센서 감지 오류',
    category: '센서계통',
    symptoms: '센서 LED 미점등, 센서 상시 점등, PLC 입력 신호 불안정, 감지 안됨',
    cause: '센서 감지 거리 이탈, 배선 단선, 센서 본체 파손, 금속 칩 부착',
    steps: [
      '센서 전면부에 금속 칩이나 이물질이 부착되어 있는지 육안 점검합니다.',
      '감지 대상물과 센서 간의 거리가 사양 범위(보통 2~5mm) 이내인지 확인합니다.',
      '센서 커넥터를 분리 후 재결합하여 접촉 불량 여부를 점검합니다.',
      '멀티미터로 센서 출력 전압(DC 12~24V)을 측정합니다.',
      '이상 시 동일 사양의 예비 센서로 교체 후 PLC 입력 신호를 확인합니다.'
    ],
    caution: '센서 교체 시 반드시 동일 타입(NPN/PNP)을 사용하세요. 극성 오접속 시 센서가 파손됩니다.',
    tags: ['센서', '감지오류', 'PLC', '신호불안정']
  },
  {
    title: '유압 펌프 이상',
    category: '유압계통',
    symptoms: '유압 압력 부족, 펌프 이상 소음, 유온 상승, 오일 누유',
    cause: '오일 부족, 필터 막힘, 펌프 내부 마모, 릴리프 밸브 이상',
    steps: [
      '유압 탱크의 오일 레벨을 확인하고 부족 시 보충합니다.',
      '오일 필터의 차압 게이지를 확인하고 적색 영역이면 필터를 교체합니다.',
      '유온이 60°C를 초과하면 설비를 정지하고 냉각합니다.',
      '릴리프 밸브의 설정 압력이 규정값(보통 14MPa)인지 확인합니다.',
      '이상 지속 시 펌프 내부 마모가 의심되므로 전문 정비를 의뢰합니다.'
    ],
    caution: '고온의 유압 오일에 의한 화상 위험이 있습니다. 보호 장갑을 착용하세요.',
    tags: ['유압', '펌프', '오일', '필터', '누유']
  },
  {
    title: '컨베이어 벨트 사행 및 슬립',
    category: '컨베이어',
    symptoms: '벨트가 한쪽으로 치우침, 이송 속도 불안정, 벨트 마모, 제품 이탈',
    cause: '텐션 불균형, 롤러 정렬 불량, 벨트 표면 오염',
    steps: [
      '설비를 정지하고 벨트 표면의 오염물(오일, 이물질)을 제거합니다.',
      '구동 롤러와 종동 롤러의 평행도를 수평기로 확인합니다.',
      '텐션 조절 볼트를 이용하여 벨트 장력을 균일하게 조정합니다.',
      '벨트 사행 방향의 반대쪽 텐션을 약간 높여 교정합니다.',
      '저속 운전하며 벨트 주행 상태를 5분 이상 관찰합니다.'
    ],
    caution: '벨트 조정 시 회전부에 손이 끼이지 않도록 주의하세요. 반드시 정지 상태에서 작업하세요.',
    tags: ['컨베이어', '벨트', '사행', '슬립', '이송']
  }
];

// OpenAI Function Definitions
const tools = [
  {
    type: "function",
    function: {
      name: "get_work_orders",
      description: "작업지시 목록을 조회합니다. '작업지시', '작업목록', '지시사항', '작업계획' 등을 언급할 때 사용하세요. 생산 '실적'이나 '완료된 양'과는 구분됩니다.",
      parameters: {
        type: "object",
        properties: {
          line_id: { type: "integer", description: "조회할 라인 ID (옵션)" },
          status: { type: "string", description: "작업 상태 (진행중, 준비중, 완료 등)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_production_results",
      description: "생산 실적 정보를 전체 조회하거나 특정 제품에 대해 조회합니다. '생산실적', '생산현황', '작업결과', '양품/불량 수량' 등을 언급할 때 사용하세요. '작업지시(계획)'와는 구분됩니다. 제품명을 모르는 경우 파라미터 없이 호출하세요.",
      parameters: {
        type: "object",
        properties: {
          product_name: { type: "string", description: "제품명 (옵션)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_add_work_order",
      description: "새로운 작업지시 추가를 위한 확인을 요청합니다.",
      parameters: {
        type: "object",
        properties: {
          product: { type: "string", description: "제품명" },
          line: { type: "string", description: "생산 라인" },
          qty: { type: "string", description: "계획 수량" }
        },
        required: ["product", "line", "qty"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_edit_work_order",
      description: "기존 작업지시 수정을 위한 확인을 요청합니다. 작업번호(wo_id)는 수정할 대상을 식별하는 용도로만 사용되며, 작업번호 자체를 수정할 수는 없습니다.",
      parameters: {
        type: "object",
        properties: {
          wo_id: { type: "string", description: "수정할 대상의 기존 작업지시 ID (예: WO-2024-011). 다른 ID로 변경하는 것은 불가능합니다." },
          product: { type: "string", description: "변경할 제품명 (옵션)" },
          line: { type: "string", description: "변경할 생산 라인 (옵션)" },
          qty: { type: "integer", description: "변경할 계획 수량 (옵션)" },
          status: { type: "string", description: "변경할 상태 (대기, 진행중, 완료 등) (옵션). 사용자가 '시작', '중단', '완료' 등을 요청하면 이에 맞춰 변환하세요." }
        },
        required: ["wo_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_input_production_result",
      description: "생산 실적을 새로 입력하거나 기존 실적을 수정하기 위한 확인을 요청합니다. '수정', '변경', '고쳐줘' 등의 단어가 있거나 실적 ID(RT-...)가 언급되면 반드시 is_update를 true로 설정하세요.",
      parameters: {
        type: "object",
        properties: {
          result_id: { type: "string", description: "수정할 실적의 ID (예: RT-2026-001). 실적 수정 시 필수입니다." },
          wo_id: { type: "string", description: "작업지시 ID (예: WO-2024-011). 신규 실적 입력 시 필수입니다." },
          good_qty: { type: "integer", description: "양품 수량 (수정 시 언급하지 않으면 기존 값 유지)" },
          defect_qty: { type: "integer", description: "불량 수량 (수정 시 언급하지 않으면 기존 값 유지)" },
          worker_name: { type: "string", description: "작업자 이름 (수정 시 언급하지 않으면 기존 값 유지)" },
          is_update: { type: "boolean", description: "기존 실적을 수정하는 경우 true (명시적인 수정 요청 시 필수), 새로 입력하는 경우 false (기본값)" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_delete_work_order",
      description: "기존 작업지시 삭제를 위한 확인을 요청합니다.",
      parameters: {
        type: "object",
        properties: {
          wo_id: { type: "string", description: "삭제할 작업지시 ID (예: WO-2024-011)" }
        },
        required: ["wo_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_defects",
      description: "불량 내역을 조회합니다.",
      parameters: {
        type: "object",
        properties: {
          result_id: { type: "integer", description: "생산 실적 ID (옵션)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "request_delete_production_result",
      description: "기존 생산 실적 삭제를 위한 확인을 요청합니다. 특정 실적 ID(result_id)를 지정하여 삭제합니다.",
      parameters: {
        type: "object",
        properties: {
          result_id: { type: "string", description: "삭제할 실적의 ID (예: RT-2024-011)" }
        },
        required: ["result_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_factory_status",
      description: "전체 공장 가동 현황 및 대시보드를 조회합니다.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "request_scheduling",
      description: "생산 스케줄링, 작업 배분, 라인 배치 최적화를 요청합니다. '스케줄', '배분', '배치', '최적', '계획 추천', '어떻게 나눠', '어떻게 배분', '효율 분석', '가동 분석' 등을 언급할 때 사용하세요.",
      parameters: {
        type: "object",
        properties: {
          product: { type: "string", description: "생산할 제품명 (옵션, 예: A형 부품)" },
          target_qty: { type: "integer", description: "목표 생산량 (옵션, 예: 1000)" },
          priority: { type: "string", description: "우선순위 기준: 'speed'(속도 우선), 'quality'(품질 우선), 'balanced'(균형) (기본값: balanced)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_maintenance_guide",
      description: "설비 고장, 이상 증상, 조치방법을 검색합니다. 사용자가 설비 문제를 설명하면 매뉴얼에서 해결 방법을 찾아줍니다. '고장', '이상', '안 움직여', '멈췄어', '소리나', '소음', '과열', '안돼', '조치', '수리', '어떻게 해', '어떻게 고쳐', '설비', '모터', '센서', '벨트', '유압', '공압', '실린더', '펌프' 등을 언급할 때 사용하세요.",
      parameters: {
        type: "object",
        properties: {
          symptom: { type: "string", description: "사용자가 설명한 설비 이상 증상 (예: '모터가 과열돼서 멈췄어', '실린더가 느려졌어', '벨트가 한쪽으로 쏠려')" }
        },
        required: ["symptom"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_production_data",
      description: "생산 Raw Data를 AI가 분석하여 불량 원인, 생산성 트렌드, 개선 인사이트를 도출합니다. '분석', '인사이트', '원인', '왜 불량', '왜 많이 나와', '데이터 분석', '생산성 분석', '불량 분석', '트렌드', '패턴', '원인 분석', '개선', '문제점' 등을 언급할 때 사용하세요.",
      parameters: {
        type: "object",
        properties: {
          focus: { type: "string", description: "분석 초점: 'defect'(불량 원인), 'productivity'(생산성), 'overall'(종합). 기본값: overall" },
          line_name: { type: "string", description: "특정 라인만 분석할 경우 라인명 (옵션, 예: '1라인')" }
        }
      }
    }
  }
];

// /api/chat 엔드포인트
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  const normalizedMessage = normalizeMESText(message);
  const t = normalizedMessage.toLowerCase();

  try {
    const inferredLine = extractLineName(message) || extractLineName(normalizedMessage);
    const inferredStatus = inferRequestedStatus(message) || inferRequestedStatus(normalizedMessage);
    const inferredWoId = normalizedMessage.match(/WO-\d{4}-\d+/i)?.[0]?.toUpperCase();
    const inferredDelete = inferDeleteIntent(message) || inferDeleteIntent(normalizedMessage);

    if (inferredWoId && inferredDelete) {
      const deleteConfirmResponse = await buildDeleteWorkOrderConfirm(inferredWoId);
      if (deleteConfirmResponse) {
        return res.json(deleteConfirmResponse);
      }
    }

    if (inferredLine && inferredStatus && !inferredWoId) {
      // 라인 기반 상태 변경은 항상 사용자 확인 후 실행
      const quickEditResponse = await buildLineStatusEditConfirm(inferredLine, inferredStatus);
      if (quickEditResponse) {
        return res.json(quickEditResponse);
      }
    }

    // --- 작업 수정 (Edit) 로직 개선 ---
    // 특정 단어 단독 입력 시 목록 표시
    if (t === "작업 수정" || t === "작업수정" || t === "수정" || t === "변경") {
      const dbRes = await pool.query(`
            SELECT w.wo_id as id, w.product_name as product, l.line_name as line, w.planned_qty as planned, w.actual_qty as actual, w.status 
            FROM work_orders w JOIN lines l ON w.line_id = l.line_id 
            WHERE w.status != '완료' ORDER BY w.created_at DESC
        `);
      return res.json({
        type: 'table',
        text: '수정할 작업의 번호를 확인해 주세요.\n"WO-2024-011 수량 500개로 변경"과 같이 말씀하시면 수정을 도와드릴게요.',
        tableType: 'workorder',
        tableTitle: '수정 가능 작업 목록',
        headers: ['ID', '제품명', '라인', '계획', '실적', '상태'],
        rows: dbRes.rows
      });
    }

    // --- 주제 전환 감지 및 컨텍스트 초기화 ---
    const hasWorkOrderKeyword = /(작업지시|작업목록|지시사항|작업계획|작업번호|작업수정|작업상태|무슨\s*작업|진행\s*상황)/.test(t);
    const hasProductionKeyword = /(생산실적|생산현황|작업결과|양품|불량|얼마나\s*만들었|생산량)/.test(t);

    let finalHistory = history || [];
    // 작업지시와 생산실적 키워드가 동시에 나오지 않고 하나만 명확히 나올 경우 이전 문맥 무시 (최신 1개만 남김)
    if ((hasWorkOrderKeyword && !hasProductionKeyword) || (!hasWorkOrderKeyword && hasProductionKeyword)) {
      console.log('Topic switch detected. Reducing history to minimize interference.');
      finalHistory = finalHistory.slice(-1);
    } else {
      finalHistory = finalHistory.slice(-5);
    }

    console.log('Calling OpenAI API...');
    const messages = [
      {
        role: "system", content: `당신은 MES(제조 실행 시스템) AI Agent입니다. 
사용자의 요청을 분석하여 적절한 기능을 호출하십시오.

[중요 지침]
- **사용자가 주제를 바꾸면(예: 실적 조회 후 작업지시 요청), 이전 대화 내용은 완전히 무시하고 현재 요청의 키워드에만 집중하십시오.**
- 이전 대화(History)에서 '생산실적'을 다뤘더라도, 현재 질문에 '작업지시'가 포함되어 있다면 반드시 get_work_orders를 호출해야 합니다. 반대의 경우도 마찬가지입니다.

[작업지시 vs 생산실적 구분 지침]
- '작업지시(Work Order)': 미래에 할 작업, 현재 진행 중인 작업의 '상태'나 '계획'을 조회/수정할 때 사용합니다. (예: "작업지시 보여줘", "지금 무슨 작업해?", "작업지시 수정해줘")
- '생산실적(Production Result)': 이미 수행된 작업의 '결과', '생산량', '양품/불량 수'를 조회/입력할 때 사용합니다. (예: "생산실적 보여줘", "오늘 얼마나 만들었어?", "실적 입력해줘")
- 사용자가 "작업지시"를 물으면 get_work_orders를, "생산실적"이나 "생산량"을 물으면 get_production_results를 호출하세요.
- 단순히 "조회해줘"라고만 하면 이전 문맥을 참고하되, 명시적인 키워드가 있다면 키워드를 우선하십시오.

[스케줄링/생산계획 지침]
- 사용자가 '스케줄링', '스케줄', '생산계획', '배분', '배치 최적화', '라인 배분', '효율 분석', '가동 분석', '어떻게 나눠', '어떻게 배분', '최적 계획' 등을 언급하면 request_scheduling을 호출하세요.
- priority 파라미터: 사용자가 '빨리', '급해', '속도' 등을 언급하면 'speed', '품질', '불량' 등을 언급하면 'quality', 그 외에는 'balanced'로 설정하세요.

[설비 고장/조치방법 지침]
- 사용자가 설비 이상 증상을 설명하면 (예: '모터가 멈췄어', '실린더가 안 움직여', '벨트가 쏠려', '소리가 나', '과열') search_maintenance_guide를 호출하세요.
- symptom 파라미터에는 사용자가 설명한 증상을 그대로 넣으세요.
- '고장', '이상', '조치방법', '수리', '어떻게 고쳐', '어떻게 해' 등의 키워드가 있으면 반드시 search_maintenance_guide를 호출하세요.

[데이터 분석/인사이트 지침]
- 사용자가 '분석', '인사이트', '원인', '왜 불량', '왜 많이 나와', '데이터 분석', '불량 원인', '생산성 분석', '트렌드', '패턴', '문제점', '개선점' 등을 언급하면 analyze_production_data를 호출하세요.
- focus 파라미터: '불량', '불량률' 언급 시 'defect', '생산성', '효율' 언급 시 'productivity', 그 외에는 'overall'.
- 특정 라인을 언급하면 line_name에 해당 라인명을 넣으세요.

[기타 기능 지침]
- '작업지시 수정' 시, 사용자가 언급한 ID, 제품명, 생산라인, 수량, 상태를 정확히 추출하세요.
- "시작해줘", "시작해", "작업 시작" 등은 상태(status)를 "진행중"으로 변경하는 것으로 해석하세요.
- "가동해줘", "진행해줘", "가동시켜", "진행시켜" 등도 상태(status)를 "진행중"으로 변경하는 것으로 해석하세요.
- "중단해줘", "멈춰", "대기해" 등은 상태(status)를 "대기"로 변경하는 것으로 해석하세요.
- "완료해", "끝났어", "마쳤어" 등은 상태(status)를 "완료"로 변경하는 것으로 해석하세요.
- 만약 "3라인" 또는 "3번 라인"이라고 하면 line 파라미터에 "3라인"을 넣으세요.
- 만약 수량을 언급하면 qty 파라미터에 숫자를 넣으세요.
- 상태 변경이 명시되지 않았다면 status 파라미터는 비워두세요.
- "삭제해줘", "지워줘", "없애줘" 등은 삭제 요청으로 해석합니다.
- 만약 작업번호(WO-...)가 언급되면 request_delete_work_order를 호출하세요.
- 만약 실적 ID(RT-...)가 언급되면 request_delete_production_result를 호출하세요.
- 중요: 작업번호(wo_id)는 고유 식별자이므로 다른 번호로 수정할 수 없습니다. 사용자가 "A를 B로 수정해줘"라고 할 때 A와 B가 모두 작업번호 형식이면, A를 대상으로 인식하고 B는 수정 항목으로 넣지 마세요.
- 모든 작업번호(wo_id)는 대문자(예: WO-2024-011)로 추출하세요.
- 모든 실적 ID(result_id)는 대문자(예: RT-2026-001)로 추출하세요.
- '실적 조회' 요청 시 제품명이 명시되지 않았다면 파라미터 없이 get_production_results를 호출하여 전체 목록을 보여주세요.
- 중요: '실적 수정', '실적 변경' 요청 시, 실적 ID(예: RT-2026-001)가 언급되면 반드시 is_update를 true로 설정하고 result_id 파라미터를 사용하세요.
- 중요: '실적 삭제' 요청 시, 실적 ID(예: RT-2026-001)가 언급되면 request_delete_production_result를 호출하세요.
- 대화의 맥락(history)보다 사용자의 '마지막 요청(user message)'에 포함된 키워드를 최우선으로 고려하여 도구를 선택하세요. 이전 질문이 '생산실적'이었더라도 현재 질문이 '작업지시'라면 반드시 get_work_orders를 호출해야 합니다.` }
    ];

    if (finalHistory.length > 0) {
      finalHistory.forEach(h => {
        messages.push({ role: h.role, content: h.content });
      });
    }

    messages.push({ role: "user", content: normalizedMessage });

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o",
      messages: messages,
      tools: tools,
      tool_choice: "auto",
    });
    console.log('OpenAI response received');

    const responseMessage = response.choices[0].message;

    if (responseMessage.tool_calls) {
      const toolCall = responseMessage.tool_calls[0];
      const functionName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      if (functionName === "get_work_orders") {
        const query = args.line_id
          ? [`SELECT w.wo_id as id, w.product_name as product, l.line_name as line, w.planned_qty as planned, w.actual_qty as actual, w.status 
                FROM work_orders w JOIN lines l ON w.line_id = l.line_id 
                WHERE w.line_id = $1 ORDER BY w.created_at DESC`, [args.line_id]]
          : [`SELECT w.wo_id as id, w.product_name as product, l.line_name as line, w.planned_qty as planned, w.actual_qty as actual, w.status 
                FROM work_orders w JOIN lines l ON w.line_id = l.line_id 
                ORDER BY w.created_at DESC`, []];

        const dbRes = await pool.query(query[0], query[1]);
        return res.json({
          type: 'table',
          text: '작업지시 목록을 조회했습니다.',
          tableType: 'workorder',
          tableTitle: 'WORK ORDERS',
          headers: ['ID', '제품명', '라인', '계획', '실적', '상태'],
          rows: dbRes.rows
        });
      }

      if (functionName === "get_production_results") {
        const query = args.product_name
          ? [`SELECT r.result_id as id, r.result_id as result_id, r.result_id as "resultId", r.wo_id as wo, r.good_qty as good, r.defect_qty as defect, r.worker_name as worker
              FROM production_results r
              JOIN work_orders w ON r.wo_id = w.wo_id
              WHERE w.product_name ILIKE $1
              ORDER BY r.recorded_at DESC`, [`%${args.product_name}%`]]
          : [`SELECT r.result_id as id, r.result_id as result_id, r.result_id as "resultId", r.wo_id as wo, r.good_qty as good, r.defect_qty as defect, r.worker_name as worker
              FROM production_results r
              ORDER BY r.recorded_at DESC`, []];

        const dbRes = await pool.query(query[0], query[1]);
        return res.json({
          type: 'table',
          text: args.product_name ? `'${args.product_name}' 제품의 생산 실적 정보를 조회했습니다.` : '전체 생산 실적 정보를 조회했습니다.',
          tableType: 'production',
          tableTitle: 'PRODUCTION RESULTS',
          headers: ['ID', '작업번호', '양품', '불량', '작업자'],
          rows: dbRes.rows
        });
      }

      if (functionName === "request_add_work_order") {
        return res.json({
          type: 'confirm',
          confirmType: 'add',
          text: '작업지시를 아래 내용으로 추가하시겠습니까?',
          confirmData: { line: args.line, product: args.product, qty: args.qty }
        });
      }

      if (functionName === "request_edit_work_order") {
        const explicitWoId = normalizedMessage.match(/WO-\d{4}-\d+/i)?.[0]?.toUpperCase() || null;
        const requestedWoId = typeof args.wo_id === 'string' ? args.wo_id.trim().toUpperCase() : null;
        const requestedLine = args.line || inferredLine;
        const requestedStatus = args.status || inferredStatus;

        if (requestedLine && requestedStatus && !explicitWoId) {
          const lineEditResponse = await buildLineStatusEditConfirm(requestedLine, requestedStatus);
          if (lineEditResponse) {
            return res.json(lineEditResponse);
          }
        }

        if (!requestedWoId) {
          return res.json({
            type: 'text',
            text: '수정할 작업번호를 찾지 못했습니다. 작업번호를 말씀하시거나, "3라인 작업 진행해줘"처럼 라인을 함께 말씀해 주세요.'
          });
        }

        const woId = requestedWoId;

        // 존재 여부 확인
        const checkRes = await pool.query('SELECT wo_id FROM work_orders WHERE wo_id = $1', [woId]);
        if (checkRes.rows.length === 0) {
          return res.json({
            type: 'text',
            text: `작업번호 ${woId}는 존재하지 않는 번호입니다. 확인 후 다시 말씀해 주세요.`
          });
        }

        // 수정할 내용 요약 생성
        let summaryArr = [];
        let fields = [];
        let values = [];

        if (args.product) {
          summaryArr.push(`제품: ${args.product}`);
          fields.push('제품');
          values.push(args.product);
        }
        if (args.line) {
          summaryArr.push(`라인: ${args.line}`);
          fields.push('라인');
          values.push(args.line);
        }
        if (args.qty) {
          summaryArr.push(`수량: ${args.qty}개`);
          fields.push('수량');
          values.push(args.qty);
        }
        if (args.status) {
          summaryArr.push(`상태: ${args.status}`);
          fields.push('상태');
          values.push(args.status);
        }

        const summaryStr = summaryArr.join(', ');

        return res.json({
          type: 'confirm',
          confirmType: 'edit',
          text: `작업지시 ${woId}번을 아래 내용으로 수정하시겠습니까?\n${summaryStr}`,
          confirmData: {
            wo_id: woId,
            woId: woId,
            product: args.product,
            line: args.line,
            qty: args.qty,
            status: args.status,
            field: fields.join(', '),
            newValue: values.join(', '),
            summary: summaryStr
          }
        });
      }

      if (functionName === "request_delete_production_result") {
        const resultId = args.result_id;

        // 특정 실적 ID로 조회
        const checkRes = await pool.query(`
            SELECT r.result_id, r.wo_id, r.good_qty, r.defect_qty, r.worker_name, l.line_name
            FROM production_results r
            JOIN work_orders w ON r.wo_id = w.wo_id
            JOIN lines l ON w.line_id = l.line_id
            WHERE r.result_id = $1
        `, [resultId]);

        if (checkRes.rows.length === 0) {
          return res.json({
            type: 'text',
            text: `실적 ID ${resultId}에 대한 생산 실적이 존재하지 않습니다.`
          });
        }

        const resData = checkRes.rows[0];

        return res.json({
          type: 'confirm',
          confirmType: 'delete-result',
          text: `실적 ID ${resData.result_id}을 삭제하시겠습니까?\n(작업번호: ${resData.wo_id}, 양품: ${resData.good_qty}, 불량: ${resData.defect_qty}, 작업자: ${resData.worker_name || '미지정'})`,
          confirmData: {
            wo_id: resData.wo_id,
            result_id: resData.result_id,
            good_qty: resData.good_qty
          }
        });
      }

      if (functionName === "request_input_production_result") {
        const resultId = args.result_id;
        const woId = args.wo_id ? args.wo_id.toUpperCase() : null;
        const isUpdate = args.is_update || false;

        if (isUpdate && resultId) {
          // 수정 시: result_id 하나로만 조회
          const checkRes = await pool.query(`
              SELECT r.result_id, r.wo_id, r.good_qty, r.defect_qty, r.worker_name, l.line_name 
              FROM production_results r
              JOIN work_orders w ON r.wo_id = w.wo_id
              JOIN lines l ON w.line_id = l.line_id 
              WHERE r.result_id = $1
          `, [resultId]);

          if (checkRes.rows.length === 0) {
            return res.json({
              type: 'text',
              text: `실적 ID ${resultId}는 존재하지 않는 실적입니다. 확인 후 다시 말씀해 주세요.`
            });
          }

          const resData = checkRes.rows[0];
          // 언급되지 않은 값은 기존 값 유지
          const finalGood = args.good_qty !== undefined ? args.good_qty : resData.good_qty;
          const finalDefect = args.defect_qty !== undefined ? args.defect_qty : resData.defect_qty;
          const finalWorker = args.worker_name || resData.worker_name;

          return res.json({
            type: 'confirm',
            confirmType: 'input-result',
            text: `생산실적 수정 확인 (실적 ID: ${resultId})\n라인: ${resData.line_name}\n작업번호: ${resData.wo_id}\n양품: ${finalGood}\n불량: ${finalDefect}\n요청 작업자: ${finalWorker || '미지정'}`,
            confirmData: {
              wo_id: resData.wo_id,
              result_id: resultId,
              good_qty: finalGood,
              defect_qty: finalDefect,
              worker: finalWorker,
              is_update: true
            }
          });
        } else {
          // 신규 입력: wo_id, good_qty, defect_qty 필요
          if (!woId) {
            return res.json({
              type: 'text',
              text: '신규 실적을 입력하려면 작업번호(예: WO-2024-011)를 함께 말씀해 주세요.'
            });
          }
          if (args.good_qty === undefined || args.defect_qty === undefined) {
            return res.json({
              type: 'text',
              text: '신규 실적 입력 시 양품 수량과 불량 수량을 함께 말씀해 주세요.'
            });
          }

          const checkRes = await pool.query(`
              SELECT w.wo_id, l.line_name 
              FROM work_orders w 
              JOIN lines l ON w.line_id = l.line_id 
              WHERE w.wo_id = $1
          `, [woId]);

          if (checkRes.rows.length === 0) {
            return res.json({
              type: 'text',
              text: `작업번호 ${woId}는 존재하지 않는 번호입니다. 확인 후 다시 말씀해 주세요.`
            });
          }

          const lineName = checkRes.rows[0].line_name;
          return res.json({
            type: 'confirm',
            confirmType: 'input-result',
            text: `생산실적 입력 확인\n라인: ${lineName}\n작업번호: ${woId}\n양품: ${args.good_qty}\n불량: ${args.defect_qty}\n요청 작업자: ${args.worker_name || '미지정'}`,
            confirmData: {
              wo_id: woId,
              good_qty: args.good_qty,
              defect_qty: args.defect_qty,
              worker: args.worker_name,
              is_update: false
            }
          });
        }
      }

      if (functionName === "request_delete_work_order") {
        const requestedWoId = typeof args.wo_id === 'string' ? args.wo_id.trim().toUpperCase() : null;
        if (!requestedWoId) {
          return res.json({
            type: 'text',
            text: '삭제할 작업번호를 찾지 못했습니다. "WO-2026-002 삭제해줘"처럼 말씀해 주세요.'
          });
        }

        const deleteConfirmResponse = await buildDeleteWorkOrderConfirm(requestedWoId);
        if (deleteConfirmResponse) {
          return res.json(deleteConfirmResponse);
        }
      }

      if (functionName === "get_defects") {
        const query = args.result_id
          ? ['SELECT defect_id as id, defect_id as defect_id, defect_id as "defectId", result_id, defect_type as type, qty FROM defects WHERE result_id = $1', [args.result_id]]
          : ['SELECT defect_id as id, defect_id as defect_id, defect_id as "defectId", result_id, defect_type as type, qty FROM defects', []];
        const dbRes = await pool.query(query[0], query[1]);
        return res.json({
          type: 'table',
          text: '불량 내역을 조회했습니다.',
          tableType: 'defect',
          tableTitle: 'DEFECTS',
          headers: ['ID', '실적ID', '불량유형', '수량'],
          rows: dbRes.rows
        });
      }

      if (functionName === "get_factory_status") {
        const lineRes = await pool.query(`
              SELECT 
                  l.line_name as name, 
                  CASE 
                      WHEN EXISTS (SELECT 1 FROM work_orders WHERE line_id = l.line_id AND status = '진행중') THEN '가동중'
                      WHEN EXISTS (SELECT 1 FROM work_orders WHERE line_id = l.line_id AND status = '대기') THEN '준비중'
                      ELSE '정지'
                  END as status,
                  COALESCE(
                      ROUND((SUM(w.actual_qty)::numeric / NULLIF(SUM(w.planned_qty), 0)) * 100, 2), 
                      0
                  ) as progress
              FROM lines l
              LEFT JOIN work_orders w ON l.line_id = w.line_id
              GROUP BY l.line_id, l.line_name
              ORDER BY l.line_id
          `);
        return res.json({
          type: 'progress',
          text: '공장 전체 가동 현황입니다.',
          lines: lineRes.rows
        });
      }

      // ===== 지능형 생산 스케줄링 핸들러 =====
      if (functionName === "request_scheduling") {
        const targetProduct = args.product || null;
        const targetQty = args.target_qty || null;
        const priority = args.priority || 'balanced';

        // 1. 라인별 현재 상태 및 성능 데이터 수집
        const lineDataRes = await pool.query(`
          SELECT 
            l.line_id,
            l.line_name,
            CASE 
              WHEN EXISTS (SELECT 1 FROM work_orders WHERE line_id = l.line_id AND status = '진행중') THEN '가동중'
              WHEN EXISTS (SELECT 1 FROM work_orders WHERE line_id = l.line_id AND status = '대기') THEN '준비중'
              ELSE '유휴'
            END as current_status,
            COUNT(w.wo_id) FILTER (WHERE w.status IN ('진행중', '대기')) as active_orders,
            COALESCE(SUM(w.planned_qty) FILTER (WHERE w.status IN ('진행중', '대기')), 0) as current_load,
            COALESCE(SUM(w.actual_qty) FILTER (WHERE w.status IN ('진행중', '대기')), 0) as current_actual
          FROM lines l
          LEFT JOIN work_orders w ON l.line_id = w.line_id
          GROUP BY l.line_id, l.line_name
          ORDER BY l.line_id
        `);

        // 2. 최근 생산 실적에서 라인별 평균 생산성과 불량률 계산
        const perfDataRes = await pool.query(`
          SELECT 
            w.line_id,
            l.line_name,
            COALESCE(AVG(r.good_qty), 0) as avg_good_per_result,
            CASE 
              WHEN SUM(r.good_qty + r.defect_qty) > 0 
              THEN ROUND((SUM(r.defect_qty)::numeric / SUM(r.good_qty + r.defect_qty)) * 100, 1)
              ELSE 0 
            END as defect_rate_pct,
            COUNT(r.result_id) as total_results
          FROM production_results r
          JOIN work_orders w ON r.wo_id = w.wo_id
          JOIN lines l ON w.line_id = l.line_id
          GROUP BY w.line_id, l.line_name
          ORDER BY w.line_id
        `);

        // 3. 데이터를 LLM에게 전달하여 최적 스케줄 생성
        const linesSummary = lineDataRes.rows.map(l => {
          const perf = perfDataRes.rows.find(p => p.line_id === l.line_id);
          return `- ${l.line_name}: 상태=${l.current_status}, 현재작업=${l.active_orders}건(잔여 ${l.current_load - l.current_actual}개), 평균생산성=${perf ? Math.round(perf.avg_good_per_result) : '데이터없음'}개/회, 불량률=${perf ? perf.defect_rate_pct : 0}%`;
        }).join('\n');

        const schedulingPrompt = `당신은 MES 생산 스케줄링 전문가입니다. 아래 공장 데이터를 분석하여 최적의 생산 계획을 JSON 형식으로 제안하세요.

[현재 라인 상태]
${linesSummary}

[요청 사항]
- 제품: ${targetProduct || '미지정 (전체 라인 효율 최적화)'}
- 목표 수량: ${targetQty || '미지정 (현재 잔여 작업 기준 최적화)'}
- 우선순위: ${priority === 'speed' ? '속도 우선 (납기 준수 최우선)' : priority === 'quality' ? '품질 우선 (불량률 최소화)' : '균형 (속도와 품질 균형)'}

[응답 형식 - 반드시 아래 JSON만 출력하세요]
{
  "title": "스케줄링 제목 (예: A형 부품 1000개 최적 배분안)",
  "plan": "전체적인 배분 전략을 2~3문장으로 설명",
  "schedules": [
    { "line": "1라인", "product": "제품명", "qty": "수량", "time": "예상소요시간" },
    { "line": "2라인", "product": "제품명", "qty": "수량", "time": "예상소요시간" }
  ],
  "expectedQty": "기대 총 생산량 또는 효율 향상 비율",
  "timeSaving": "기존 대비 절감 시간",
  "reason": "이 배분을 선택한 근거 (데이터 기반으로 1~2문장)"
}`;

        try {
          const schedulingResponse = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            messages: [
              { role: 'system', content: '반드시 JSON 형식으로만 응답하세요. 다른 텍스트를 포함하지 마세요.' },
              { role: 'user', content: schedulingPrompt }
            ],
            response_format: { type: 'json_object' }
          });

          const scheduleData = JSON.parse(schedulingResponse.choices[0].message.content);
          console.log('[Scheduling] AI 스케줄링 결과:', JSON.stringify(scheduleData));

          return res.json({
            type: 'recommend',
            title: scheduleData.title || '생산 스케줄 최적화 결과',
            plan: scheduleData.plan || '현재 라인 상태를 기반으로 최적 배분안을 산출했습니다.',
            schedules: scheduleData.schedules || [],
            expectedQty: scheduleData.expectedQty || '+15%',
            timeSaving: scheduleData.timeSaving || '30min',
            text: scheduleData.reason || '데이터 기반 최적화 완료',
            confirmType: 'scheduling',
            confirmData: {
              schedules: scheduleData.schedules || [],
              product: targetProduct
            }
          });

        } catch (aiErr) {
          console.error('[Scheduling] AI 분석 오류:', aiErr);
          return res.json({
            type: 'text',
            text: '스케줄링 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'
          });
        }
      }

      // ===== 설비 매뉴얼 RAG 핸들러 (증상 기반) =====
      if (functionName === "search_maintenance_guide") {
        const symptom = args.symptom || '';

        // 매뉴얼 전체를 LLM에게 전달하여 증상 매칭
        const kbSummary = EQUIPMENT_MANUAL.map(d =>
          `■ ${d.title} (${d.category})\n  증상: ${d.symptoms}\n  원인: ${d.cause}\n  조치: ${d.steps.join(' → ')}\n  주의: ${d.caution}\n  태그: ${d.tags.join(', ')}`
        ).join('\n\n');

        const ragPrompt = `당신은 공장 설비 유지보수 전문가입니다.
사용자가 설명한 증상을 아래 매뉴얼 데이터와 비교하여, 가장 적합한 조치 방법을 JSON 형식으로 답하세요.

[사용자가 설명한 증상]
${symptom}

[설비 유지보수 매뉴얼 데이터]
${kbSummary}

[응답 규칙]
- 매뉴얼에서 가장 유사한 항목을 찾아 답하세요.
- 에러코드는 사용하지 마세요.
- 반드시 아래 JSON 형식으로만 출력하세요.

{
  "source": "설비 유지보수 매뉴얼 - [카테고리명]",
  "content": "이 증상에 대한 핵심 요약 1~2문장",
  "steps": ["조치 단계 1", "조치 단계 2", "..."],
  "caution": "주의사항 1문장",
  "tags": ["관련태그1", "관련태그2"],
  "confidence": 85
}`;

        try {
          const ragResponse = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            messages: [
              { role: 'system', content: '반드시 JSON 형식으로만 응답하세요.' },
              { role: 'user', content: ragPrompt }
            ],
            response_format: { type: 'json_object' }
          });

          const ragData = JSON.parse(ragResponse.choices[0].message.content);
          console.log('[RAG] 매뉴얼 검색 결과:', JSON.stringify(ragData));

          return res.json({
            type: 'knowledge',
            source: ragData.source || '설비 유지보수 매뉴얼',
            content: ragData.content || '',
            steps: ragData.steps || [],
            caution: ragData.caution || null,
            tags: ragData.tags || [],
            confidence: ragData.confidence || 80,
            text: ragData.content || '매뉴얼 검색 완료'
          });
        } catch (aiErr) {
          console.error('[RAG] AI 분석 오류:', aiErr);
          return res.json({
            type: 'text',
            text: '설비 매뉴얼 검색 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'
          });
        }
      }

      // ===== 생산 데이터 마이닝 / 인사이트 핸들러 =====
      if (functionName === "analyze_production_data") {
        const focus = args.focus || 'overall';
        const lineName = args.line_name || null;

        // 1. 라인별 생산성 & 불량률 집계
        const lineFilter = lineName ? `AND l.line_name = '${lineName}'` : '';
        const kpiRes = await pool.query(`
          SELECT
            l.line_name,
            COUNT(r.result_id) AS total_records,
            COALESCE(SUM(r.good_qty), 0) AS total_good,
            COALESCE(SUM(r.defect_qty), 0) AS total_defect,
            COALESCE(SUM(r.good_qty + r.defect_qty), 0) AS total_produced,
            CASE
              WHEN SUM(r.good_qty + r.defect_qty) > 0
              THEN ROUND((SUM(r.defect_qty)::numeric / SUM(r.good_qty + r.defect_qty)) * 100, 2)
              ELSE 0
            END AS defect_rate,
            COALESCE(AVG(r.good_qty), 0) AS avg_good_per_session
          FROM lines l
          LEFT JOIN work_orders w ON l.line_id = w.line_id
          LEFT JOIN production_results r ON w.wo_id = r.wo_id
          ${lineFilter ? `WHERE l.line_name = $1` : 'WHERE 1=1'}
          GROUP BY l.line_id, l.line_name
          ORDER BY defect_rate DESC
        `, lineName ? [lineName] : []);

        // 2. 불량 유형별 집계
        const defectRes = await pool.query(`
          SELECT
            d.defect_type,
            SUM(d.qty) AS total_qty,
            COUNT(d.defect_id) AS occurrences,
            l.line_name
          FROM defects d
          JOIN production_results r ON d.result_id = r.result_id
          JOIN work_orders w ON r.wo_id = w.wo_id
          JOIN lines l ON w.line_id = l.line_id
          ${lineName ? `WHERE l.line_name = $1` : ''}
          GROUP BY d.defect_type, l.line_name
          ORDER BY total_qty DESC
          LIMIT 10
        `, lineName ? [lineName] : []);

        // 3. 최근 7일 일별 생산량 트렌드
        const trendRes = await pool.query(`
          SELECT
            DATE(r.recorded_at) AS date,
            SUM(r.good_qty) AS daily_good,
            SUM(r.defect_qty) AS daily_defect,
            CASE
              WHEN SUM(r.good_qty + r.defect_qty) > 0
              THEN ROUND((SUM(r.defect_qty)::numeric / SUM(r.good_qty + r.defect_qty)) * 100, 1)
              ELSE 0
            END AS daily_defect_rate
          FROM production_results r
          WHERE r.recorded_at >= NOW() - INTERVAL '7 days'
          GROUP BY DATE(r.recorded_at)
          ORDER BY date DESC
        `);

        // 4. 작업자별 성과 (불량률 기준)
        const workerRes = await pool.query(`
          SELECT
            COALESCE(r.worker_name, '미지정') AS worker,
            COUNT(r.result_id) AS sessions,
            SUM(r.good_qty) AS total_good,
            SUM(r.defect_qty) AS total_defect,
            CASE
              WHEN SUM(r.good_qty + r.defect_qty) > 0
              THEN ROUND((SUM(r.defect_qty)::numeric / SUM(r.good_qty + r.defect_qty)) * 100, 1)
              ELSE 0
            END AS defect_rate
          FROM production_results r
          GROUP BY r.worker_name
          ORDER BY total_good DESC
          LIMIT 5
        `);

        // 5. 수집된 Raw Data를 LLM에게 전달하여 인사이트 도출
        const kpiSummary = kpiRes.rows.map(r =>
          `- ${r.line_name}: 총생산=${r.total_produced}개, 양품=${r.total_good}개, 불량=${r.total_defect}개, 불량률=${r.defect_rate}%, 평균생산성=${Math.round(r.avg_good_per_session)}개/회`
        ).join('\n');

        const defectSummary = defectRes.rows.length > 0
          ? defectRes.rows.map(d => `- [${d.line_name}] ${d.defect_type}: ${d.total_qty}개 (${d.occurrences}건)`).join('\n')
          : '- 불량 데이터 없음';

        const trendSummary = trendRes.rows.length > 0
          ? trendRes.rows.map(t => `- ${t.date}: 양품 ${t.daily_good}개, 불량률 ${t.daily_defect_rate}%`).join('\n')
          : '- 최근 7일 데이터 없음';

        const workerSummary = workerRes.rows.length > 0
          ? workerRes.rows.map(w => `- ${w.worker}: ${w.sessions}회 작업, 양품 ${w.total_good}개, 불량률 ${w.defect_rate}%`).join('\n')
          : '- 작업자 데이터 없음';

        const miningPrompt = `당신은 스마트 제조 데이터 분석 전문가입니다.
아래 생산 Raw Data를 분석하여 핵심 인사이트와 개선 권고사항을 JSON 형식으로 제공하세요.

[분석 초점: ${focus === 'defect' ? '불량 원인 분석' : focus === 'productivity' ? '생산성 분석' : '종합 분석'}]
${lineName ? `[분석 대상 라인: ${lineName}]` : '[분석 대상: 전체 라인]'}

[라인별 KPI]
${kpiSummary || '- 데이터 없음'}

[불량 유형 분석]
${defectSummary}

[최근 7일 생산 트렌드]
${trendSummary}

[작업자별 성과]
${workerSummary}

[응답 형식 - 반드시 아래 JSON만 출력하세요]
{
  "summary": "데이터 분석 요약 1~2문장",
  "insights": [
    { "type": "warning", "title": "발견된 문제", "content": "구체적 수치와 함께 설명" },
    { "type": "info", "title": "주목할 트렌드", "content": "구체적 수치와 함께 설명" },
    { "type": "success", "title": "긍정적 지표", "content": "구체적 수치와 함께 설명" }
  ],
  "rootCause": "가장 심각한 문제의 근본 원인 분석 (데이터 기반)",
  "recommendations": ["개선 권고 1", "개선 권고 2", "개선 권고 3"]
}`;

        try {
          const insightResponse = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            messages: [
              { role: 'system', content: '반드시 JSON 형식으로만 응답하세요. 다른 텍스트를 포함하지 마세요.' },
              { role: 'user', content: miningPrompt }
            ],
            response_format: { type: 'json_object' }
          });

          const insightData = JSON.parse(insightResponse.choices[0].message.content);
          console.log('[Insight] 데이터 마이닝 결과:', JSON.stringify(insightData));

          return res.json({
            type: 'insight',
            summary: insightData.summary || '생산 데이터 분석이 완료되었습니다.',
            insights: insightData.insights || [],
            rootCause: insightData.rootCause || null,
            recommendations: insightData.recommendations || [],
            text: insightData.summary || '데이터 마이닝 완료'
          });

        } catch (aiErr) {
          console.error('[Insight] AI 분석 오류:', aiErr);
          return res.json({
            type: 'text',
            text: '데이터 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.'
          });
        }
      }
    }

    // 기본 텍스트 응답
    res.json({ type: 'text', text: responseMessage.content || "요청을 이해하지 못했습니다. 다시 말씀해 주세요." });

  } catch (error) {
    console.error('OpenAI or DB Error:', error);
    res.status(500).json({
      type: 'text',
      text: '서버 처리 중 오류가 발생했습니다.'
    });
  }
});

// 실행(Execute) 엔드포인트 - confirm 후 최종 DB 반영
app.post('/api/execute', async (req, res) => {
  const { action, data } = req.body;

  try {
    if (action === 'add-workorder') {
      // line 이름으로 line_id 조회
      const lineRes = await pool.query('SELECT line_id FROM lines WHERE line_name = $1', [data.line]);
      const lineId = lineRes.rows.length > 0 ? lineRes.rows[0].line_id : 1;

      // WO-YYYY-NNN 형식 ID 생성 (간략화)
      const year = new Date().getFullYear();
      const maxIdRes = await pool.query("SELECT MAX(wo_id) as max_id FROM work_orders WHERE wo_id LIKE $1", [`WO-${year}-%`]);
      let nextNum = 1;
      if (maxIdRes.rows[0].max_id) {
        const lastNum = parseInt(maxIdRes.rows[0].max_id.split('-')[2]);
        nextNum = lastNum + 1;
      }
      const newWoId = `WO-${year}-${nextNum.toString().padStart(3, '0')}`;

      if (!data.product) {
        return res.json({ success: false, message: '제품명이 누락되었습니다. 제품명을 입력해 주세요.' });
      }

      const qty = parseInt(data.qty) || 0;
      await pool.query(
        'INSERT INTO work_orders (wo_id, product_name, line_id, planned_qty, actual_qty, status, due_date) VALUES ($1, $2, $3, $4, 0, $5, CURRENT_DATE + INTERVAL \'7 days\')',
        [newWoId, data.product, lineId, qty, '대기']
      );

      // 라인 상태 업데이트
      await updateLineStatus(lineId);

      return res.json({ success: true, message: `작업지시 ${newWoId}가 추가되었습니다.` });
    }

    if (action === 'edit-workorder') {
      const { wo_id, product, line, qty, status } = data;

      // 0. 기존 라인 ID 조회 (라인 변경 시 상태 업데이트 위해)
      const oldWoRes = await pool.query('SELECT line_id FROM work_orders WHERE wo_id = $1', [wo_id]);
      const oldLineId = oldWoRes.rows.length > 0 ? oldWoRes.rows[0].line_id : null;

      let query = 'UPDATE work_orders SET ';
      const params = [];
      const updates = [];
      let newLineId = null;

      if (product) {
        params.push(product);
        updates.push(`product_name = $${params.length}`);
      }
      if (qty) {
        params.push(parseInt(qty));
        updates.push(`planned_qty = $${params.length}`);
      }
      if (status) {
        params.push(status);
        updates.push(`status = $${params.length}`);
      }
      if (line) {
        const lineRes = await pool.query('SELECT line_id FROM lines WHERE line_name = $1', [line]);
        if (lineRes.rows.length > 0) {
          newLineId = lineRes.rows[0].line_id;
          params.push(newLineId);
          updates.push(`line_id = $${params.length}`);
        }
      }

      if (updates.length === 0) return res.json({ success: false, message: '수정할 내용이 없습니다.' });

      params.push(wo_id);
      query += updates.join(', ') + ` WHERE wo_id = $${params.length}`;
      await pool.query(query, params);

      // 진행률 체크 (자동 완료 처리)
      await checkWorkOrderCompletion(wo_id);

      // 관련 라인들의 상태 업데이트
      if (oldLineId) await updateLineStatus(oldLineId);
      if (newLineId && newLineId !== oldLineId) await updateLineStatus(newLineId);
      // 만약 라인이 안바뀌었더라도 상태(status)가 바뀌었을 수 있으므로 업데이트
      if (!newLineId && oldLineId) await updateLineStatus(oldLineId);

      return res.json({ success: true, message: `작업지시 ${wo_id}가 수정되었습니다.` });
    }

    if (action === 'input-result') {
      const { wo_id, good_qty, defect_qty, worker, woId, goodQty, defectQty, is_update, result_id } = data;
      const targetGoodQty = (good_qty !== undefined) ? good_qty : (goodQty !== undefined ? goodQty : 0);
      const targetDefectQty = (defect_qty !== undefined) ? defect_qty : (defectQty !== undefined ? defectQty : 0);

      if (is_update) {
        // 기존 실적 수정: 오직 result_id 기반
        const resultId = result_id;
        if (!resultId) {
          return res.json({ success: false, message: '수정할 실적 ID가 없습니다.' });
        }

        // 기존 실적 및 연결된 작업 정보 조회
        const oldResultRes = await pool.query('SELECT wo_id, good_qty FROM production_results WHERE result_id = $1', [resultId]);
        if (oldResultRes.rows.length === 0) {
          return res.json({ success: false, message: `실적 ID ${resultId}를 찾을 수 없습니다.` });
        }

        const { wo_id: targetWoId, good_qty: oldGoodQty } = oldResultRes.rows[0];

        // 1. 실적 테이블 UPDATE
        await pool.query(
          'UPDATE production_results SET good_qty = $1, defect_qty = $2, worker_name = $3, recorded_at = NOW() WHERE result_id = $4',
          [targetGoodQty, targetDefectQty, worker, resultId]
        );

        // 2. 작업지시 actual_qty 업데이트 (차이만큼 반영)
        await pool.query(
          'UPDATE work_orders SET actual_qty = actual_qty - $1 + $2 WHERE wo_id = $3',
          [oldGoodQty, targetGoodQty, targetWoId]
        );

        // 3. 라인 상태 업데이트
        const woLineRes = await pool.query('SELECT line_id FROM work_orders WHERE wo_id = $1', [targetWoId]);
        if (woLineRes.rows.length > 0) {
          await updateLineStatus(woLineRes.rows[0].line_id);
        }

        // 진행률 체크 (자동 완료 처리)
        await checkWorkOrderCompletion(targetWoId);

        return res.json({ success: true, message: `생산 실적 ${resultId}가 수정되었습니다.` });

      } else {
        // 신규 입력: wo_id 기반
        const targetWoId = wo_id || woId;
        if (!targetWoId) {
          return res.json({ success: false, message: '작업번호가 없습니다.' });
        }

        const year = new Date().getFullYear();
        const maxIdRes = await pool.query("SELECT MAX(result_id) as max_id FROM production_results WHERE result_id LIKE $1", [`RT-${year}-%`]);
        let nextNum = 1;
        if (maxIdRes.rows[0].max_id) {
          const lastNum = parseInt(maxIdRes.rows[0].max_id.split('-')[2]);
          nextNum = lastNum + 1;
        }
        const newResultId = `RT-${year}-${nextNum.toString().padStart(3, '0')}`;

        await pool.query(
          'INSERT INTO production_results (result_id, wo_id, good_qty, defect_qty, worker_name, recorded_at) VALUES ($1, $2, $3, $4, $5, NOW())',
          [newResultId, targetWoId, targetGoodQty, targetDefectQty, worker]
        );
        await pool.query(
          'UPDATE work_orders SET actual_qty = actual_qty + $1 WHERE wo_id = $2',
          [targetGoodQty, targetWoId]
        );

        const woLineRes = await pool.query('SELECT line_id FROM work_orders WHERE wo_id = $1', [targetWoId]);
        if (woLineRes.rows.length > 0) {
          await updateLineStatus(woLineRes.rows[0].line_id);
        }

        // 진행률 체크 (자동 완료 처리)
        await checkWorkOrderCompletion(targetWoId);

        return res.json({ success: true, message: `생산 실적 ${newResultId}가 기록되었습니다.` });
      }
    }

    if (action === 'delete-workorder') {
      const { wo_id } = data;
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const oldWoRes = await client.query('SELECT line_id FROM work_orders WHERE wo_id = $1', [wo_id]);
        if (oldWoRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.json({ success: false, message: `작업지시 ${wo_id}는 존재하지 않습니다.` });
        }

        const oldLineId = oldWoRes.rows[0].line_id;
        const resultIdsRes = await client.query('SELECT result_id FROM production_results WHERE wo_id = $1', [wo_id]);
        const resultIds = resultIdsRes.rows.map(row => row.result_id);

        if (resultIds.length > 0) {
          await client.query('DELETE FROM defects WHERE result_id = ANY($1::varchar[])', [resultIds]);
        }
        await client.query('DELETE FROM production_results WHERE wo_id = $1', [wo_id]);
        await client.query('DELETE FROM work_orders WHERE wo_id = $1', [wo_id]);

        await client.query('COMMIT');
        await updateLineStatus(oldLineId);

        return res.json({ success: true, message: `작업지시 ${wo_id}가 삭제되었습니다.` });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    if (action === 'delete-result') {
      const { result_id } = data;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 0. 삭제 전 필요한 정보 조회 (wo_id, good_qty, line_id)
        const resInfo = await client.query(`
          SELECT r.wo_id, r.good_qty, w.line_id 
          FROM production_results r
          LEFT JOIN work_orders w ON r.wo_id = w.wo_id
          WHERE r.result_id = $1
        `, [result_id]);

        if (resInfo.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.json({ success: false, message: `실적 ID ${result_id}를 찾을 수 없습니다.` });
        }

        const { wo_id, good_qty, line_id } = resInfo.rows[0];

        // 0-1. 관련 불량 내역(defects) 삭제 (참조 무결성 오류 방지)
        await client.query('DELETE FROM defects WHERE result_id = $1', [result_id]);

        // 1. 실적 삭제
        await client.query('DELETE FROM production_results WHERE result_id = $1', [result_id]);

        // 2. 작업지시 actual_qty 차감 (작업지시가 존재하는 경우만)
        if (wo_id) {
          await client.query(
            'UPDATE work_orders SET actual_qty = actual_qty - $1 WHERE wo_id = $2',
            [good_qty, wo_id]
          );
        }

        // 3. 라인 상태 업데이트
        await client.query('COMMIT');

        // 트랜잭션 종료 후 라인 상태 업데이트 (작업지시와 라인 정보가 있는 경우만)
        if (line_id) {
          await updateLineStatus(line_id);
        }

        return res.json({ success: true, message: `생산 실적 ${result_id}가 삭제되었습니다.` });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Delete result error:', err);
        throw err;
      } finally {
        client.release();
      }
    }

    // ===== 스케줄링 확정 → 작업지시 자동 생성 =====
    if (action === 'apply-scheduling') {
      const { schedules, product } = data;
      if (!schedules || schedules.length === 0) {
        return res.json({ success: false, message: '적용할 스케줄 데이터가 없습니다.' });
      }

      const year = new Date().getFullYear();
      const createdWoIds = [];

      for (const s of schedules) {
        // 라인 ID 조회
        const lineRes = await pool.query('SELECT line_id FROM lines WHERE line_name = $1', [s.line]);
        const lineId = lineRes.rows.length > 0 ? lineRes.rows[0].line_id : 1;

        // WO ID 생성
        const maxIdRes = await pool.query("SELECT MAX(wo_id) as max_id FROM work_orders WHERE wo_id LIKE $1", [`WO-${year}-%`]);
        let nextNum = 1;
        if (maxIdRes.rows[0].max_id) {
          const lastNum = parseInt(maxIdRes.rows[0].max_id.split('-')[2]);
          nextNum = lastNum + 1;
        }
        const newWoId = `WO-${year}-${nextNum.toString().padStart(3, '0')}`;

        const qty = parseInt(s.qty) || 0;
        const productName = s.product || product || '미지정';

        await pool.query(
          'INSERT INTO work_orders (wo_id, product_name, line_id, planned_qty, actual_qty, status, due_date) VALUES ($1, $2, $3, $4, 0, $5, CURRENT_DATE + INTERVAL \'1 day\')',
          [newWoId, productName, lineId, qty, '대기']
        );
        await updateLineStatus(lineId);
        createdWoIds.push(newWoId);
      }

      return res.json({
        success: true,
        message: `스케줄링이 확정되었습니다. ${createdWoIds.length}건의 작업지시가 생성되었습니다. (${createdWoIds.join(', ')})`
      });
    }

    res.status(400).json({ success: false, message: '알 수 없는 액션입니다.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'DB 오류가 발생했습니다.' });
  }
});

// --- CRUD API (Direct access) ---

// Work Orders CRUD
app.get('/api/work-orders', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM work_orders ORDER BY created_at DESC');
  res.json(rows);
});

app.post('/api/work-orders', async (req, res) => {
  const { wo_id, product_name, line_id, planned_qty, due_date } = req.body;
  await pool.query('INSERT INTO work_orders (wo_id, product_name, line_id, planned_qty, status, due_date) VALUES ($1, $2, $3, $4, $5, $6)',
    [wo_id, product_name, line_id, planned_qty, '대기', due_date]);

  await updateLineStatus(line_id);
  res.json({ success: true });
});

app.put('/api/work-orders/:id', async (req, res) => {
  const { id } = req.params;
  const { status, actual_qty, product_name, planned_qty, line_id } = req.body;

  // 기존 라인 정보 조회
  const oldWo = await pool.query('SELECT line_id FROM work_orders WHERE wo_id = $1', [id]);
  const oldLineId = oldWo.rows.length > 0 ? oldWo.rows[0].line_id : null;

  await pool.query('UPDATE work_orders SET status = $1, actual_qty = $2, product_name = $3, planned_qty = $4, line_id = COALESCE($5, line_id) WHERE wo_id = $6',
    [status, actual_qty, product_name, planned_qty, line_id, id]);

  // 진행률 체크 (자동 완료 처리)
  await checkWorkOrderCompletion(id);

  if (oldLineId) await updateLineStatus(oldLineId);
  if (line_id && line_id !== oldLineId) await updateLineStatus(line_id);

  res.json({ success: true });
});

app.patch('/api/work-orders/:id', async (req, res) => {
  const { id } = req.params;
  const { status, actual_qty, product_name, planned_qty, line_id, due_date } = req.body;

  // 기존 라인 정보 조회
  const oldWo = await pool.query('SELECT line_id FROM work_orders WHERE wo_id = $1', [id]);
  const oldLineId = oldWo.rows.length > 0 ? oldWo.rows[0].line_id : null;

  let query = 'UPDATE work_orders SET ';
  const params = [];
  const updates = [];

  if (status !== undefined) { params.push(status); updates.push(`status = $${params.length}`); }
  if (actual_qty !== undefined) { params.push(actual_qty); updates.push(`actual_qty = $${params.length}`); }
  if (product_name !== undefined) { params.push(product_name); updates.push(`product_name = $${params.length}`); }
  if (planned_qty !== undefined) { params.push(planned_qty); updates.push(`planned_qty = $${params.length}`); }
  if (line_id !== undefined) { params.push(line_id); updates.push(`line_id = $${params.length}`); }
  if (due_date !== undefined) { params.push(due_date); updates.push(`due_date = $${params.length}`); }

  if (updates.length === 0) return res.json({ success: false, message: '수정할 내용이 없습니다.' });

  params.push(id);
  query += updates.join(', ') + ` WHERE wo_id = $${params.length}`;

  try {
    await pool.query(query, params);

    // 진행률 체크 (자동 완료 처리)
    await checkWorkOrderCompletion(id);

    if (oldLineId) await updateLineStatus(oldLineId);
    if (line_id && line_id !== oldLineId) await updateLineStatus(line_id);
    if (!line_id && oldLineId) await updateLineStatus(oldLineId);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/work-orders/:id', async (req, res) => {
  const oldWo = await pool.query('SELECT line_id FROM work_orders WHERE wo_id = $1', [req.params.id]);
  const oldLineId = oldWo.rows.length > 0 ? oldWo.rows[0].line_id : null;

  await pool.query('DELETE FROM work_orders WHERE wo_id = $1', [req.params.id]);

  if (oldLineId) await updateLineStatus(oldLineId);
  res.json({ success: true });
});

// Production Results
app.get('/api/production-results', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM production_results ORDER BY recorded_at DESC');
  res.json(rows);
});

app.post('/api/production-results', async (req, res) => {
  const { wo_id, good_qty, defect_qty, worker_name } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultRes = await client.query(
      'INSERT INTO production_results (wo_id, good_qty, defect_qty, worker_name) VALUES ($1, $2, $3, $4) RETURNING result_id',
      [wo_id, good_qty, defect_qty, worker_name]
    );
    await client.query(
      'UPDATE work_orders SET actual_qty = actual_qty + $1 WHERE wo_id = $2',
      [good_qty, wo_id]
    );
    await client.query('COMMIT');

    // 진행률 체크 (자동 완료 처리)
    await checkWorkOrderCompletion(wo_id);

    res.json({ success: true, result_id: resultRes.rows[0].result_id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  } finally {
    client.release();
  }
});

// Defects
app.get('/api/defects', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM defects ORDER BY defect_id DESC');
  res.json(rows);
});

// Lines CRUD
app.get('/api/lines', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM lines');
  res.json(rows);
});

app.listen(port, () => {
  console.log(`MES AI Agent Backend running on port ${port}`);
});
