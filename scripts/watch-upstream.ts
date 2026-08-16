/**
 * upstream 릴리스를 감지하고, 지난 사이클에 새로 들어온 문서를 모은다.
 *
 *   npx tsx scripts/watch-upstream.ts
 *   npx tsx scripts/watch-upstream.ts --since <sha>   # 상태 파일 대신 임의 시점부터
 *   npx tsx scripts/watch-upstream.ts --print         # 수집 결과를 사람이 읽게 출력
 *
 * 출력: data/generated/upstream-new.json  (propose-nodes.ts 의 입력)
 *
 * 이 스크립트는 LLM 을 부르지 않는다. 전부 git 과 파일 읽기다.
 * 릴리스가 없으면 여기서 끝나므로 대부분의 실행은 비용이 0 이다.
 *
 * 릴리스 신호로 hugo.toml 의 `latest = "vX.Y"` 한 줄을 본다.
 * upstream 이 릴리스마다 "update hugo.toml for 1.34 release" 같은 커밋으로
 * 이 줄을 올린다. 태그나 release 브랜치보다 신호가 명확하다 —
 * 브랜치는 릴리스 전에 미리 잘리지만 이 줄은 릴리스 당일에 바뀐다.
 *
 * 왜 주 1회가 아니라 릴리스마다인가: 문서는 릴리스 당일이 아니라 그 다음
 * 사이클 내내 들어온다. 릴리스 시점에 걷으면 (1) 문서가 이미 안정돼 있고
 * (2) 같은 사이클에 들어온 문서끼리의 edge 를 한 번에 볼 수 있다.
 * 실제로 podgroup-api / workload-api 계열은 서로를 선수로 거는데,
 * 한 건씩 처리했다면 그 edge 는 만들어지지 않았다.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const UPSTREAM = "https://github.com/kubernetes/website.git";
const REPO = ".cache/website";
const STATE_FILE = "data/upstream-state.json";
const OUT_DIR = "data/generated";
const OUT_FILE = join(OUT_DIR, "upstream-new.json");

// 로드맵이 다루는 범위. reference/ 나 setup/ 은 선수 지식 그래프의 성격과 맞지 않는다.
const WATCHED = ["content/en/docs/concepts", "content/en/docs/tasks"];

// 문서 본문을 통째로 넣으면 토큰이 커진다. 선수 지식 판단에 필요한 건
// 앞부분(overview + 첫 몇 절)이고, 뒤쪽은 대개 설정 예시와 YAML 덩어리다.
const BODY_LIMIT = 12_000;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};

const git = (args: string[], cwd = REPO) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });

/* ---------- 1. 클론 확보 ----------
 * fetch-l10n.ts 와 같은 blobless partial clone 을 공유한다.
 * 다만 여기서는 파일 내용이 필요하므로, 대상 파일의 blob 은 checkout 시점에
 * 자동으로 받아온다(partial clone 의 on-demand fetch). 신규 문서는 많아야
 * 수십 개라 이 비용은 무시할 만하다. */
if (!existsSync(join(REPO, ".git"))) {
  mkdirSync(REPO, { recursive: true });
  console.log("kubernetes/website 를 받는 중 (blobless, 수 분 소요)...");
  execFileSync(
    "git",
    ["clone", "--filter=blob:none", "--no-tags", "--single-branch", UPSTREAM, REPO],
    { stdio: "inherit" }
  );
} else {
  console.log("기존 클론 갱신 중...");
  git(["fetch", "--filter=blob:none", "--no-tags", "origin"]);
  git(["reset", "--hard", "origin/HEAD"]);
}

const head = git(["rev-parse", "HEAD"]).trim();

/* ---------- 2. 릴리스 감지 ---------- */
const hugo = readFileSync(join(REPO, "hugo.toml"), "utf8");
const m = hugo.match(/^latest\s*=\s*"(v[\d.]+)"/m);
if (!m) {
  console.error("hugo.toml 에서 latest 를 찾지 못했습니다. upstream 형식이 바뀐 것 같습니다.");
  process.exit(1);
}
const upstreamVersion = m[1];

type State = { version: string; commit: string; processedAt: string };
const state: State = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : { version: "", commit: "", processedAt: "" };

const since = flag("--since") ?? state.commit;

console.log(`upstream ${upstreamVersion} / 마지막 처리 ${state.version || "(없음)"}`);

if (!flag("--since") && upstreamVersion === state.version) {
  // 여기가 대부분의 실행이 끝나는 지점이다. 워크플로는 이 표식을 보고 유료 단계를 건너뛴다.
  console.log("새 릴리스 없음 — 할 일이 없습니다.");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, ".skip"), "");
  process.exit(0);
}

if (!since) {
  // 기준점이 없으면 "무엇이 새로운지"를 정의할 수 없다. 전부 새 문서로 볼 수는 없다 —
  // 그러면 이미 그래프에 있는 것을 뺀 나머지 300여 건이 쏟아진다.
  console.error(
    `기준 커밋이 없습니다. ${STATE_FILE} 의 commit 을 채우거나 --since <sha> 를 주세요.`
  );
  process.exit(1);
}

/* ---------- 3. 신규 문서 수집 ----------
 * --diff-filter=A 는 "추가된 파일"만 고른다. 수정(M)은 제외한다 —
 * 연 177건이나 되지만 대부분 오타 수정이고, 이미 노드가 있는 문서의
 * 선수 지식이 편집 한 번으로 바뀌는 일은 드물다. 필요하면 사람이 고친다. */
const range = `${since}..HEAD`;
const raw = git(["log", "--diff-filter=A", "--name-only", "--pretty=format:", range, "--", ...WATCHED]);

const added = [...new Set(raw.split("\n").filter((l) => l.endsWith(".md")))].sort();

/* ---------- 4. 이미 그래프에 있는 문서 제외 ----------
 * URL <-> 저장소 경로 매핑은 fetch-l10n.ts 와 같은 Hugo 규칙을 따른다.
 *   content/en/docs/a/b.md        -> https://kubernetes.io/docs/a/b/
 *   content/en/docs/a/b/_index.md -> https://kubernetes.io/docs/a/b/ */
const toUrl = (path: string) => {
  const p = path.replace(/^content\/en\//, "").replace(/\/_index\.md$/, "").replace(/\.md$/, "");
  return `https://kubernetes.io/${p}/`;
};

type Node = { id: string; title: { ko: string; en: string }; url: string; section: string; requires: string[] };
const nodes = readdirSync("data/nodes")
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => parse(readFileSync(join("data/nodes", f), "utf8")) as Node);

const known = new Set(nodes.map((n) => n.url.replace(/\/$/, "")));
const fresh = added.filter((p) => !known.has(toUrl(p).replace(/\/$/, "")));

/* ---------- 5. 용어집 색인 ----------
 * 쿠버네티스 문서는 개념을 링크가 아니라 {{< glossary_tooltip term_id="pod" >}}
 * 로 참조하는 일이 많다. term_id -> full_link 를 풀어 두면 링크만 볼 때보다
 * 후보 재현율이 35% -> 47% 로 오른다. 절반도 못 잡으므로 후보를 이걸로
 * 좁히지는 않고(노드 101개가 통째로 프롬프트에 들어간다) 힌트로만 준다. */
const glossary = new Map<string, string>();
const gdir = join(REPO, "content/en/docs/reference/glossary");
if (existsSync(gdir)) {
  for (const f of readdirSync(gdir)) {
    if (!f.endsWith(".md")) continue;
    const fl = readFileSync(join(gdir, f), "utf8").match(/^full_link:\s*(\S+)/m);
    if (fl) glossary.set(f.replace(/\.md$/, ""), fl[1]);
  }
}

const urlToId = new Map(nodes.map((n) => [n.url.replace(/\/$/, ""), n.id]));
const normalize = (u: string) =>
  ("https://kubernetes.io" + u.replace("https://kubernetes.io", "")).replace(/#.*$/, "").replace(/\/$/, "");

const hintsFor = (body: string): string[] => {
  const out = new Set<string>();
  for (const l of body.matchAll(/\/docs\/[a-z0-9/-]+/g)) {
    const id = urlToId.get(normalize("https://kubernetes.io" + l[0]));
    if (id) out.add(id);
  }
  for (const t of body.matchAll(/term_id="([a-z0-9-]+)"/g)) {
    const link = glossary.get(t[1]);
    if (!link) continue;
    const id = urlToId.get(normalize(link));
    if (id) out.add(id);
  }
  return [...out].sort();
};

/* ---------- 6. 문서 본문 읽기 ---------- */
const frontMatter = (t: string) => {
  const fm = t.match(/^---\n([\s\S]*?)\n---\n/);
  return { meta: fm ? fm[1] : "", body: fm ? t.slice(fm[0].length) : t };
};

type Doc = {
  path: string;
  url: string;
  titleEn: string;
  titleKo: string | null; // 한국어 번역이 이미 있으면 공식 제목을 그대로 쓴다
  addedAt: string;
  hints: string[];
  body: string;
  truncated: boolean;
};

const docs: Doc[] = [];
for (const path of fresh) {
  const full = join(REPO, path);
  if (!existsSync(full)) continue; // 추가된 뒤 삭제된 문서
  const { meta, body } = frontMatter(readFileSync(full, "utf8"));
  const titleEn = (meta.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1] ?? "").trim();

  const koPath = join(REPO, path.replace("content/en/", "content/ko/"));
  const titleKo = existsSync(koPath)
    ? (frontMatter(readFileSync(koPath, "utf8")).meta.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1] ?? "").trim() || null
    : null;

  const addedAt = git(["log", "--diff-filter=A", "--date=short", "--format=%ad", "-1", "--", path]).trim();

  docs.push({
    path,
    url: toUrl(path),
    titleEn,
    titleKo,
    addedAt,
    hints: hintsFor(body),
    body: body.slice(0, BODY_LIMIT).trim(),
    truncated: body.length > BODY_LIMIT,
  });
}

/* ---------- 7. 출력 ---------- */
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      upstream: { version: upstreamVersion, commit: head, since: since || null },
      docs,
    },
    null,
    2
  ) + "\n"
);

console.log(`\n${OUT_FILE} 생성`);
console.log(`  ${range} 구간 신규 문서 ${added.length}개`);
console.log(`  그래프에 없는 것 ${docs.length}개`);

if (argv.includes("--print")) {
  console.log("");
  for (const d of docs) {
    console.log(`  ${d.addedAt}  ${d.titleEn}`);
    console.log(`      ${d.url}`);
    console.log(`      힌트: ${d.hints.join(", ") || "(없음)"}`);
  }
}

if (!docs.length) console.log("\n제안할 문서가 없습니다.");
