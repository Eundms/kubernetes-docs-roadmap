/**
 * watch-upstream.ts 가 모은 신규 문서를 노드 초안으로 만든다. 유일하게 돈이 드는 단계다.
 *
 *   npx tsx scripts/propose-nodes.ts
 *   npx tsx scripts/propose-nodes.ts --dry-run    # 프롬프트만 만들고 API 는 부르지 않음
 *   npx tsx scripts/propose-nodes.ts --effort max
 *
 * 입력: data/generated/upstream-new.json
 * 출력: data/nodes/<id>.yaml (초안) + data/generated/proposal.md (PR 본문)
 *
 * ── 모델에게 맡기는 일과 맡기지 않는 일 ──────────────────────────
 *
 * 맡기는 것은 하나뿐이다: "이 문서가 저 문서를 전제하고 있는가."
 * 이건 문서를 읽어야만 알 수 있고 규칙으로 환원되지 않는다.
 *
 * 나머지는 전부 기계가 한다.
 *   - 중복 edge 제거(transitive reduction)  -> validate.ts. DAG 에서 유일하게 결정된다.
 *   - 순환 검출                              -> validate.ts (Kahn)
 *   - URL 유효성                             -> check-links.ts
 *   - 한국어 번역 상태                        -> fetch-l10n.ts (git 이력)
 *   - 섹션 순서 정합성                        -> validate.ts 경고
 *
 * 그래서 모델이 틀려도 CI 가 막는다. 모델의 출력은 제안이지 결론이 아니다.
 *
 * 검색(RAG/임베딩)을 쓰지 않는 이유: 노드 101개를 전부 넣어도 5K 토큰이다.
 * 후보를 좁힐 이유가 없고, 좁히면 오히려 놓친다 — 문서가 링크하지 않고
 * 전제하는 관계(containers <- objects 같은)가 선수 지식의 본질이라
 * 링크/용어집 기반 후보 추출의 재현율은 47% 에 그쳤다. 그 신호는 버리지 않고
 * hints 로 같이 넘기되, 후보를 거기로 제한하지는 않는다.
 */
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const IN_FILE = "data/generated/upstream-new.json";
const PROPOSAL_FILE = "data/generated/proposal.md";
const MODEL = process.env.PROPOSE_MODEL ?? "claude-opus-5";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i > -1 ? argv[i + 1] : null;
};
const DRY = argv.includes("--dry-run");
const EFFORT = flag("--effort") ?? process.env.PROPOSE_EFFORT ?? "high";

if (!existsSync(IN_FILE)) {
  console.error(`${IN_FILE} 이 없습니다. 먼저 npm run watch:upstream 을 실행하세요.`);
  process.exit(1);
}

type Doc = {
  path: string; url: string; titleEn: string; titleKo: string | null;
  addedAt: string; hints: string[]; body: string; truncated: boolean;
};
const input = JSON.parse(readFileSync(IN_FILE, "utf8")) as {
  upstream: { version: string; commit: string; since: string | null };
  docs: Doc[];
};

if (!input.docs.length) {
  console.log("제안할 문서가 없습니다.");
  process.exit(0);
}

/* ---------- 1. 그래프 스냅샷 ----------
 * 프롬프트의 안정 구간이다. 여기까지가 cache_control 경계이며, 재시도 호출은
 * 이 접두사를 캐시에서 읽는다. 노드가 늘어도 노드당 40토큰 수준이라
 * 수백 개까지는 통째로 넣는 편이 검색을 붙이는 것보다 싸고 정확하다. */
type Node = {
  id: string; title: { ko: string; en: string }; url: string;
  section: string; spine?: boolean; requires: string[]; tags?: string[];
};
const nodes = readdirSync("data/nodes")
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => parse(readFileSync(join("data/nodes", f), "utf8")) as Node);

const sections = parse(readFileSync("data/sections.yaml", "utf8")) as {
  id: string; title: { ko: string; en: string }; lede: string;
}[];

const graphSnapshot = [
  "## 섹션 (화면 위에서 아래 순서)",
  ...sections.map((s, i) => `${i + 1}. ${s.id} — ${s.title.ko} / ${s.title.en}: ${s.lede}`),
  "",
  "## 노드 (id | 섹션 | 한국어 제목 | 영문 제목 | 직접 선수 지식)",
  ...nodes
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((n) => `${n.id} | ${n.section} | ${n.title.ko} | ${n.title.en} | ${n.requires.join(", ") || "-"}`),
].join("\n");

/* ---------- 2. 규칙 ----------
 * CONTRIBUTING.md 의 requires 규칙을 그대로 옮긴 것이다. 사람 기여자와 모델에게
 * 같은 기준을 적용해야 리뷰가 한 가지 기준으로 굴러간다. */
const RULES = `
너는 kubernetes.io 공식 문서를 선수 지식 그래프(DAG)로 잇는 저장소의 기여자다.
새로 올라온 문서를 보고, 그래프에 넣을지 판단하고 넣는다면 직접 선수 지식을 정한다.

# 판단 기준

## 넣을지 말지
넣는다: 독자가 언젠가 읽어야 할 개념/작업 문서. 다른 문서가 전제로 삼을 만한 내용.
넣지 않는다:
  - 특정 기능을 켜고 끄는 절차만 있는 운영 문서 (예: feature gate 설정법)
  - 이미 있는 노드와 내용이 겹쳐 별도 노드가 될 이유가 없는 문서
  - 목차/랜딩 페이지라 자체 내용이 거의 없는 _index (단, 하위 개념을 정의하면 넣는다)
  - 하드닝 가이드, 트러블슈팅 등 특정 상황에서만 찾아보는 참고 문서
애매하면 넣지 않는다. 노드는 나중에 추가할 수 있지만, 잘못 들어간 노드는 남는다.

## requires (직접 선수 지식)
1. **직접만.** A <- B <- C 일 때 A 의 requires 에 C 를 쓰지 않는다. B 를 통해 이미 도달한다.
   판정은 기계적이다. CI 가 중복 edge 를 에러로 막으므로 넉넉히 쓰면 반드시 실패한다.
2. **관행이 아니라 문서 내용이 근거다.**
   ✗ "보통 Service 를 먼저 배운다"
   ✓ "Ingress 문서는 Service 의 type: ClusterIP 동작을 전제로 서술되어 있다"
   evidence 에는 문서에서 그렇게 판단한 근거 문장을 원문 그대로 인용한다.
   인용할 문장이 없으면 그 edge 는 쓰지 않는다.
3. 보통 1~2개다. 3개를 넘으면 대부분 간접 선수 지식을 섞은 것이다.
4. 이번 배치의 다른 신규 문서도 선수 지식이 될 수 있다. 같은 사이클에 들어온
   문서끼리 서로를 전제하는 경우가 실제로 있다 (podgroup-api 계열).

## 나머지 필드
- id: kebab-case, 파일명과 같아진다. URL 마지막 조각을 따르되 짧고 읽히게.
- title.ko: 한국어 번역이 이미 있으면 titleKo 로 주어진다. 그대로 쓴다. 임의 번역 금지.
  없으면 공식 문서 제목을 자연스러운 한국어로 옮긴다. 번역 투를 피한다.
- title.en: 영문 문서 제목 원문.
- section: 섹션 목록의 id 중 하나. 선수 지식이 자기보다 아래 섹션에 있으면 안 된다.
- spine: 그 섹션의 대표 노드일 때만 true. 섹션당 2개까지다. 보통 false.
- tags: 기존 노드가 쓰는 태그를 재사용한다.

# 지금 그래프
`.trim();

const system: Anthropic.TextBlockParam[] = [
  {
    type: "text",
    text: `${RULES}\n\n${graphSnapshot}`,
    // 안정 접두사. 재시도 호출이 여기를 캐시에서 읽는다.
    cache_control: { type: "ephemeral" },
  },
];

/* ---------- 3. 출력 스키마 ----------
 * 구조화 출력을 쓰는 이유는 파싱 실패를 없애려는 게 아니라, "넣지 않음"을
 * 일급 응답으로 만들기 위해서다. 자유 서술로 두면 모델은 무언가를 제안하는
 * 쪽으로 기운다. skipped 배열을 강제하면 기각도 답이 된다.
 * evidence 를 필수 필드로 둔 것도 같은 이유다 — 인용할 문장을 못 찾으면
 * edge 를 만들 수 없게 스키마가 막는다. */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["proposed", "skipped"],
  properties: {
    proposed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["docPath", "id", "titleKo", "titleEn", "url", "section", "spine", "tags", "requires", "rationale"],
        properties: {
          docPath: { type: "string" },
          id: { type: "string" },
          titleKo: { type: "string" },
          titleEn: { type: "string" },
          url: { type: "string" },
          section: { type: "string" },
          spine: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          requires: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "evidence"],
              properties: {
                id: { type: "string" },
                evidence: { type: "string", description: "문서에서 인용한 원문. 요약이 아니라 인용." },
              },
            },
          },
          rationale: { type: "string", description: "이 문서를 넣는 이유 한두 문장." },
        },
      },
    },
    skipped: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["docPath", "reason"],
        properties: {
          docPath: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

type Proposal = {
  proposed: {
    docPath: string; id: string; titleKo: string; titleEn: string; url: string;
    section: string; spine: boolean; tags: string[];
    requires: { id: string; evidence: string }[]; rationale: string;
  }[];
  skipped: { docPath: string; reason: string }[];
};

/* ---------- 4. 사용자 메시지 ---------- */
const docsBlock = input.docs
  .map((d) =>
    [
      `### ${d.path}`,
      `url: ${d.url}`,
      `titleEn: ${d.titleEn}`,
      `titleKo: ${d.titleKo ?? "(한국어 번역 없음 — 직접 옮길 것)"}`,
      `추가된 날짜: ${d.addedAt}`,
      `본문이 참조하는 기존 노드(링크·용어집 기준, 참고용이며 여기로 제한되지 않는다): ${d.hints.join(", ") || "없음"}`,
      d.truncated ? "(본문이 길어 앞부분만 실렸다)" : "",
      "",
      "```markdown",
      d.body,
      "```",
    ]
      .filter(Boolean)
      .join("\n")
  )
  .join("\n\n---\n\n");

const userMessage =
  `upstream ${input.upstream.version} 기준으로 새로 들어온 문서 ${input.docs.length}건이다. ` +
  `각각 그래프에 넣을지 판단하고, 넣는다면 노드를 만들어라.\n\n${docsBlock}`;

if (DRY) {
  const chars = system[0].text.length + userMessage.length;
  console.log(`--dry-run: 입력 약 ${Math.round(chars / 4 / 1000)}K 토큰 (문자 ${chars})`);
  console.log(`  규칙+그래프 ${Math.round(system[0].text.length / 4 / 1000)}K / 문서 ${Math.round(userMessage.length / 4 / 1000)}K`);
  mkdirSync("data/generated", { recursive: true });
  writeFileSync("data/generated/prompt-preview.txt", system[0].text + "\n\n=== USER ===\n\n" + userMessage);
  console.log("  data/generated/prompt-preview.txt 에 저장했습니다.");
  process.exit(0);
}

/* ---------- 5. 호출 ---------- */
const client = new Anthropic();

const call = async (messages: Anthropic.MessageParam[]) => {
  // 출력이 클 수 있어(문서 15건 + 인용문 + 사고) 스트리밍으로 받는다.
  // 비스트리밍은 max_tokens 가 크면 HTTP 타임아웃에 걸린다.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system,
    output_config: {
      effort: EFFORT as "low" | "medium" | "high" | "xhigh" | "max",
      format: { type: "json_schema", schema: SCHEMA as unknown as Record<string, unknown> },
    },
    messages,
  });
  const msg = await stream.finalMessage();

  if (msg.stop_reason === "refusal") {
    throw new Error(`모델이 응답을 거부했습니다: ${JSON.stringify(msg.stop_details)}`);
  }
  if (msg.stop_reason === "max_tokens") {
    throw new Error("max_tokens 에 걸려 출력이 잘렸습니다. 배치를 나누거나 max_tokens 를 올리세요.");
  }

  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!text) throw new Error("텍스트 블록이 없습니다.");

  const u = msg.usage;
  console.log(
    `  토큰 입력 ${u.input_tokens} (캐시 쓰기 ${u.cache_creation_input_tokens ?? 0} / 읽기 ${u.cache_read_input_tokens ?? 0}) 출력 ${u.output_tokens}`
  );
  return { parsed: JSON.parse(text.text) as Proposal, raw: text.text };
};

/* ---------- 6. YAML 쓰기 ----------
 * yaml 패키지의 stringify 는 인용 규칙이 기존 파일과 달라 diff 가 지저분해진다.
 * 필드 순서와 인용을 기존 노드에 맞춰 직접 찍는다. */
const toYaml = (p: Proposal["proposed"][number]) =>
  [
    `id: ${p.id}`,
    `title:`,
    `  ko: "${p.titleKo.replace(/"/g, '\\"')}"`,
    `  en: "${p.titleEn.replace(/"/g, '\\"')}"`,
    `url: ${p.url}`,
    `section: ${p.section}`,
    ...(p.spine ? ["spine: true"] : []),
    `requires:`,
    ...p.requires.map((r) => `  - ${r.id}`),
    `tags: [${p.tags.join(", ")}]`,
    "",
  ].join("\n");

const write = (proposal: Proposal) => {
  for (const p of proposal.proposed) writeFileSync(join("data/nodes", `${p.id}.yaml`), toYaml(p));
};

const validate = (): { ok: boolean; output: string } => {
  try {
    return { ok: true, output: execFileSync("npx", ["tsx", "scripts/validate.ts"], { encoding: "utf8" }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: (err.stdout ?? "") + (err.stderr ?? "") };
  }
};

const removeProposed = (proposal: Proposal) => {
  for (const p of proposal.proposed) {
    try {
      execFileSync("rm", ["-f", join("data/nodes", `${p.id}.yaml`)]);
    } catch {
      /* 없으면 그만 */
    }
  }
};

/* ---------- 7. 제안 -> 검증 -> (실패 시) 1회 재시도 ----------
 * validator 는 어떤 edge 가 왜 잘못됐는지 정확히 알려준다. 그 문장을 그대로
 * 되먹이는 것이 가장 싸고 확실한 교정 신호다. 사람에게 알려주는 것과 같은 문장이다. */
const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

console.log(`${MODEL} 호출 (effort=${EFFORT}, 문서 ${input.docs.length}건)...`);
let { parsed, raw } = await call(messages);
write(parsed);

let check = validate();
if (!check.ok) {
  console.log("\nvalidator 실패 — 오류를 되먹여 1회 재시도합니다.");
  console.log(check.output.split("\n").filter((l) => l.trim()).slice(-8).join("\n"));
  removeProposed(parsed);

  messages.push({ role: "assistant", content: raw });
  messages.push({
    role: "user",
    content:
      `제안한 노드로 검증기를 돌렸더니 실패했다. 아래 오류를 고쳐 전체 결과를 다시 내라.\n\n` +
      "```\n" + check.output.trim() + "\n```\n\n" +
      `"중복이므로 제거하라"는 것은 그 선수 지식이 다른 항목을 통해 이미 도달 가능하다는 뜻이다. ` +
      `해당 id 를 requires 에서 빼면 된다. 노드 자체를 지우지 마라.`,
  });

  ({ parsed, raw } = await call(messages));
  write(parsed);
  check = validate();
}

/* ---------- 8. PR 본문 ---------- */
const body = [
  `## upstream ${input.upstream.version} 신규 문서 반영 (제안)`,
  "",
  `\`${input.upstream.since ?? "(처음부터)"}\` .. \`${input.upstream.commit.slice(0, 10)}\` 구간에서 ` +
    `새로 추가된 문서 ${input.docs.length}건을 검토했습니다.`,
  `**${parsed.proposed.length}건을 노드로 제안하고 ${parsed.skipped.length}건은 넘겼습니다.**`,
  "",
  `모델: \`${MODEL}\` (effort=${EFFORT}). 아래 근거는 모델이 문서에서 인용한 문장이며, ` +
    `**리뷰는 이 인용문이 실제로 선수 지식을 뒷받침하는지만 보면 됩니다.**`,
  `중복 edge · 순환 · id 정합성은 \`npm run validate\` 가 이미 통과시켰습니다.`,
  "",
  "---",
  "",
  "## 제안하는 노드",
  "",
  ...parsed.proposed.flatMap((p) => [
    `### \`${p.id}\` — ${p.titleKo}`,
    `${p.url}`,
    `섹션 \`${p.section}\`${p.spine ? " (spine)" : ""} · 태그 \`${p.tags.join(", ")}\``,
    "",
    p.rationale,
    "",
    ...(p.requires.length
      ? p.requires.flatMap((r) => [`- **선수 지식 \`${r.id}\`** — 근거:`, `  > ${r.evidence.replace(/\n/g, " ")}`])
      : ["- (선수 지식 없음 — 루트 노드로 제안)"]),
    "",
  ]),
  "---",
  "",
  "## 넘긴 문서",
  "",
  ...(parsed.skipped.length
    ? parsed.skipped.map((s) => `- \`${s.docPath}\` — ${s.reason}`)
    : ["- (없음)"]),
  "",
  "---",
  "",
  check.ok ? "`npm run validate` 통과." : "⚠ `npm run validate` 실패 — 아래 로그를 확인하세요.",
  ...(check.ok ? [] : ["", "```", check.output.trim(), "```"]),
].join("\n");

mkdirSync("data/generated", { recursive: true });
writeFileSync(PROPOSAL_FILE, body + "\n");

/* ---------- 9. 상태 갱신 ---------- */
writeFileSync(
  "data/upstream-state.json",
  JSON.stringify(
    {
      version: input.upstream.version,
      commit: input.upstream.commit,
      processedAt: new Date().toISOString().slice(0, 10),
      note: "watch-upstream.ts 가 이 값과 upstream 의 hugo.toml latest 를 비교한다. 봇 PR 이 갱신한다.",
    },
    null,
    2
  ) + "\n"
);

console.log(`\n제안 ${parsed.proposed.length}건 / 기각 ${parsed.skipped.length}건`);
console.log(`  ${PROPOSAL_FILE} 에 PR 본문 생성`);
console.log(check.ok ? "  validate 통과" : "  ⚠ validate 실패 — 사람 확인 필요");
if (!check.ok) process.exit(1);
