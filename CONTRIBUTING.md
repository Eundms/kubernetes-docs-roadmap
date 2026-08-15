# 기여 가이드

이 프로젝트에서 **사람이 관리하는 데이터는 그래프 구조 하나**입니다.
한국어 번역 상태는 `kubernetes/website` 저장소에서 빌드 시 계산되므로 직접 입력하지 않습니다.

## 노드 추가하기

`data/nodes/<id>.yaml` 파일 하나를 만들면 끝입니다.

```yaml
id: gateway-api                                  # 파일명과 같아야 합니다
title:
  ko: 게이트웨이 API                              # 공식 한글 문서 제목 그대로
  en: Gateway API                                # 영문 문서 제목 원문
url: https://kubernetes.io/docs/concepts/services-networking/gateway/
section: networking                              # data/sections.yaml 참고
spine: false                                     # 중앙 축에 놓을 대표 노드면 true
requires:
  - ingress                                      # 직접 선수 지식만
tags: [network]
```

```bash
npm ci
npm run validate          # 통과하지 못하면 CI 도 실패합니다
npm run validate:print    # 위상 정렬된 읽기 순서 확인
npm run build             # dist/index.html 생성 (브라우저로 바로 열립니다)
```

`url` 은 **영문 정규 URL** 을 씁니다. `/ko/` 를 쓰면 스키마에서 거부됩니다.
한국어 URL 은 번역이 존재할 때 빌드가 자동으로 붙입니다.

## 쓰지 않는 것

레벨, 화면 좌표, 연결선, 읽는 순서, 번역 상태는 **전부 계산됩니다.**
필드로 존재하지 않으니 찾지 마세요. 순서를 바꾸고 싶으면 `requires` 를 고칩니다.

## `requires` 작성 규칙

### 1. 직접 선수 지식만 씁니다

```yaml
# ✗ 거부됩니다
requires: [pods, labels, objects]   # objects 는 pods 를 통해 이미 도달 가능

# ✓
requires: [pods, labels]
```

DAG 에서 transitive reduction 은 유일하게 결정되므로 이 판정은 기계적입니다.
validator 가 어떤 항목이 중복인지 정확히 알려줍니다.

이 규칙이 없으면 edge 가 노드보다 빠르게 늘어나 그래프가 몇 달 안에 못 읽는 상태가 됩니다.

### 2. 관행이 아니라 문서 내용이 근거입니다

> ✗ "보통 Service 를 먼저 배웁니다"
> ✓ "Ingress 문서는 Service 의 `type: ClusterIP` 동작을 전제로 서술되어 있습니다"

PR 본문에 이 근거를 적어 주세요. 리뷰는 이것만 봅니다.

## validator 가 잡는 것

| 검사 | |
|---|---|
| YAML 문법, 스키마 위반, 정의되지 않은 필드 | 에러 |
| 파일명 ≠ `id` | 에러 |
| `requires` 의 id 가 존재하지 않음 | 에러 |
| 순환 참조 (Kahn's algorithm) | 에러 |
| 중복 edge (transitive redundancy) | 에러 |
| 여러 노드가 같은 URL 사용 | 에러 |
| 섹션에 `spine` 노드가 없거나 3개 이상 | 경고 |
| 선수 지식이 더 아래 섹션에 있음 | 경고 |

URL 이 실제로 살아 있는지는 외부 네트워크에 의존하므로 PR 마다 확인하지 않습니다.
주 1회 스케줄로 돌고, 실패하면 이슈가 자동으로 열립니다.

## 번역 상태는 어떻게 계산되나

`scripts/fetch-l10n.ts` 가 `kubernetes/website` 를 blobless partial clone 으로 받아
커밋 이력을 한 번 훑습니다.

| 상태 | 조건 |
|---|---|
| `none` | `content/ko` 에 대응 파일이 없음 |
| `stale` | ko 가 en 보다 30일 넘게 뒤처짐 |
| `done` | 그 외 |

30일 유예를 두는 이유는 영문 쪽 오타 수정 하나로도 커밋 시각이 갱신되기 때문입니다.
실측 격차의 중앙값이 약 290일이므로 30일 유예는 실제 신호를 흐리지 않습니다.
`lagDays` 를 함께 기록하므로 UI 는 "약 3.2년 뒤처짐" 같은 표현을 씁니다.

이 계산에는 외부 서비스가 개입하지 않습니다. 필요한 것은 `git` 과 upstream 저장소뿐입니다.

```bash
npm run l10n     # data/generated/l10n.json 생성 (커밋하지 않습니다)
npm run build
```

`l10n.json` 없이도 빌드는 됩니다. 모든 노드가 "미확인" 으로 표시될 뿐입니다.
노드만 추가하는 기여자는 이 단계를 건너뛰어도 됩니다.

## 리뷰 범위

| 경로 | 리뷰어 |
|---|---|
| `data/nodes/` | 리뷰어 |
| `data/sections.yaml` | 메인테이너 — 그래프 전체 배치가 바뀝니다 |
| `schema/`, `scripts/`, `web/` | 메인테이너 |

프론트엔드를 몰라도 노드 기여는 가능합니다.

## 참고

- [Kubernetes Documentation](https://kubernetes.io/docs/home/)
- [Localizing Kubernetes documentation](https://kubernetes.io/docs/contribute/localization/)
- [JSON Schema](https://json-schema.org/) · [Ajv](https://ajv.js.org/)
- [Git partial clone](https://git-scm.com/docs/partial-clone)
