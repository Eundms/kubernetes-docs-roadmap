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
schema/
  node.schema.json     노드의 계약
scripts/
  validate.ts          DAG 검증. CI 게이트
  fetch-l10n.ts        번역 상태 계산 (kubernetes/website)
  build.ts             data/ → dist/index.html
  check-links.ts       URL 유효성 (주 1회)
web/
  template.html        렌더러
```

레벨, 좌표, 연결선, 읽는 순서는 저장하지 않고 `requires` 에서 계산합니다.

## 기여

[CONTRIBUTING.md](./CONTRIBUTING.md) 를 참고하세요. 대부분의 기여는 YAML 파일 하나입니다.

## 라이선스

Apache-2.0. 문서 내용의 저작권은 [Kubernetes Authors](https://github.com/kubernetes/website) 에 있습니다.
