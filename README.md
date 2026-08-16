# Kubernetes Docs Roadmap

kubernetes.io 공식 문서를 **선수 지식 그래프(DAG)** 로 연결한 학습 경로입니다.
각 문서의 **한국어 번역 현황** 을 함께 표시합니다.

- 화살표는 "이걸 모르면 저 문서를 읽을 수 없다"는 뜻입니다
- 카드를 누르면 그 문서까지 도달하는 선수 지식 경로가 그려집니다
- 왼쪽 색 막대가 번역 상태입니다. 미번역은 사선 패턴이라 한눈에 보입니다

## 빠르게 실행

```bash
npm ci
npm run build      # 번역 상태 없이 빌드 (빠름)
open dist/index.html
```

번역 현황까지 채우려면:

```bash
npm run l10n       # kubernetes/website 를 받아 계산 (최초 수 분)
npm run build
```

산출물은 `dist/index.html` 파일 하나입니다. 데이터가 인라인되어 있어
정적 서버 없이 `file://` 로 열어도 동작하고, GitHub Pages 에 그대로 올려도 됩니다.

## 구조

```
data/
  sections.yaml        주제 구획 (메인테이너)
  nodes/<id>.yaml      노드 하나당 파일 하나  ← 기여는 여기서
  upstream-state.json  마지막으로 반영한 upstream 릴리스
schema/
  node.schema.json     노드의 계약
scripts/
  validate.ts          DAG 검증. CI 게이트
  fetch-l10n.ts        번역 상태 계산 (kubernetes/website)
  build.ts             data/ → dist/index.html
  check-links.ts       URL 유효성 (주 1회)
  watch-upstream.ts    릴리스 감지 + 신규 문서 수집 (git 만 사용)
  propose-nodes.ts     신규 문서 → 노드 초안 + 근거 (LLM)
web/
  template.html        렌더러
```

## 새 문서 따라잡기

쿠버네티스 릴리스마다 워크플로가 upstream 의 신규 문서를 찾아 노드 초안 PR 을 엽니다.
릴리스 감지는 upstream `hugo.toml` 의 `latest` 한 줄로 하고, 릴리스가 없으면
LLM 을 부르지 않고 끝납니다.

```bash
npm run watch:upstream -- --since <sha> --print   # 무료. 무엇이 새로 들어왔는지만 본다
npm run propose -- --dry-run                      # 무료. 프롬프트만 확인
npm run propose                                   # 유료. ANTHROPIC_API_KEY 필요
```

모델이 정하는 것은 **"이 문서가 저 문서를 전제하는가"** 하나뿐입니다. 중복 edge 제거,
순환 검출, URL 유효성, 번역 상태는 전부 기존 스크립트가 기계적으로 판정하므로
모델이 틀려도 CI 가 막습니다. 제안에는 문서 원문 인용이 함께 붙고, 머지는 사람이 합니다.

레벨, 좌표, 연결선, 읽는 순서는 저장하지 않고 `requires` 에서 계산합니다.

## 기여

[CONTRIBUTING.md](./CONTRIBUTING.md) 를 참고하세요. 대부분의 기여는 YAML 파일 하나입니다.

## 라이선스

Apache-2.0. 문서 내용의 저작권은 [Kubernetes Authors](https://github.com/kubernetes/website) 에 있습니다.
