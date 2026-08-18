# devcareer-prep

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

Git 커밋 히스토리를 **결정적 스크립트**로 수집해 만든 "증거 원장(evidence ledger)"을 유일한
사실 원천으로 삼고, 그 위에 경력 기술서 → 기술 지식맵 → 학습 갭 리포트를 단방향 계층으로 쌓는
Claude Code 플러그인이다. 모든 인용의 실재성은 LLM이 아니라 스크립트가 검증한다.

> **현재 상태: 구현 진행 중 (Phase 0-A — 레포 기반 확정).**
> 이 README가 기술하는 명령·검증 하네스는 12단계 구현 계획의 목표 상태다.
> 지금 이 시점에는 `.claude-plugin/plugin.json` · `.claude-plugin/marketplace.json` ·
> `package.json` · `LICENSE` · `.gitattributes` · `.gitignore` · 이 README만 존재하며,
> 스키마·수집 스크립트·검증 스크립트·스킬은 아직 구현되지 않았다. 아래 "명령" 절의
> 상태 표시를 반드시 확인할 것.

## 설치

**마켓플레이스로 설치 (배포 이후):**

```
/plugin marketplace add Jugger0716/career-forge
/plugin install devcareer-prep@career-forge
```

**로컬 개발 테스트:**

```
claude --plugin-dir /path/to/career-forge
```

## 아키텍처 개요 — 증거 원장 → 단방향 6계층

정본은 JSON이고, 사용자 대면 마크다운은 그 JSON을 렌더링한 뷰일 뿐이다. 상위 계층은 하위 계층의
**ID만 참조**하며 역참조는 금지된다 — 이 제약이 "생성된 결과가 실제 경력과 논리적으로 연결된다"는
요구를 스키마 제약으로 강제한다.

| 계층 | 산출물 | 설명 |
|---|---|---|
| L0 | `evidence.json` | git 히스토리에서 결정적으로 수집한 불변 증거 원장. LLM은 이 값을 생성하지 않고 항목 ID만 인용한다. |
| L1 | `career.json` | 경력 기술서. 모든 사실 주장이 근거 등급(`commit`/`inference`/`external`/`insufficient`)을 갖는다. |
| L2 | `knowledge-map.json` | 기술 지식맵. |
| L3 | `gap-report.json` | 학습 갭 리포트. |
| L4 | `plan.json` | 준비 커리큘럼 (Phase 3, P0 이후). |
| L5 | 채점 | 범위 밖 (P2). |

모든 인용은 2단 팩트체크를 거친다: **1단(스크립트, 결정적)**은 원장 실존성·커밋 해시 실존성·
(해시, 경로) 쌍의 diff 등장 여부를 검사하고, **2단(LLM)**은 "이 커밋이 정말 그 주장을 뒷받침하는가"만
적대적으로 판정한다. 해시는 LLM이 생성하지 않으므로 할루시네이션 경로가 구조적으로 막힌다.

산출물의 상태 디렉터리는 `.devcareer/` 다. 기본 저장 위치는 사용자 홈 아래
(`~/.devcareer/<repo-key>/`)이며, 분석 대상 레포 내부에 저장하려면 명시적 동의가 필요하고
이 경우 해당 레포의 `.gitignore`에 `.devcareer/` 추가를 제안한다.

## 명령

정본 슬래시 명령 접두사는 `.claude-plugin/plugin.json`의 `name`(`devcareer-prep`)에서
자동 파생되므로 항상 `/devcareer-prep:`이다.

| 명령 | 범위 | 상태 |
|---|---|---|
| `/devcareer-prep:career-from-git` | P0 (MVP) | 계획됨 — 미구현 |
| `/devcareer-prep:skill-gap` | P0 (MVP, 자가진단 입력만) | 계획됨 — 미구현 |
| `/devcareer-prep:prep-plan` | Phase 3 | 계획됨 — 미구현 |
| `/devcareer-prep:grade` | P2 (MVP 제외) | 범위 밖 |

## 한계 고지 — 이 플러그인이 보증하지 않는 것

- **로컬 경로만 지원한다.** 원격 GitHub URL을 직접 clone하지 않는다 (P0 범위 밖 — 수동으로
  clone한 뒤 로컬 경로를 지정해야 한다).
- **`max_commits` 예산을 넘으면 전체 커밋을 다 분석하지 않는다.** 이 경우 결정적 샘플링 규칙에
  따라 부분 선택하며, 절단 여부와 커버리지 수치를 산출물 헤더에 항상 명시한다 — 하지만 "명시한다"는
  것이지 "모든 커밋을 본다"는 뜻은 아니다.
- **'근거 없는 주장' 탐지는 100%가 아니다.** 가짜 커밋 해시·타 저자 커밋 인용·마스킹 우회 같은
  기계적으로 결정 가능한 오염은 100% 탐지를 목표로 하지만, LLM이 판정하는 "이 서술이 정말
  근거 없는 과장인가"는 반복 실행 기준 80% 이상 탐지율만 보증한다.
- **시크릿/PII 마스킹은 알려진 패턴 기반이며 완전하지 않다.** AWS 키·private key 블록·JWT·
  이메일 등 알려진 패턴을 마스킹하지만, 이 목록에 없는 형태의 민감정보까지 잡아내지는 못한다.
- **코드 원문 인용은 기본 비활성이다.** 옵트인하지 않으면 경로·해시·요약만 인용하며 diff 원문은
  전송되지 않는다.
- **채점(`/devcareer-prep:grade`), 시스템 설계 문제 생성, 면접 꼬리질문, 여러 레포 통합 분석,
  음성 모의면접, 이력서 PDF 생성, Claude 외 LLM 지원은 MVP 범위 밖이다.**
- **저자 정체성은 추측하지 않는다.** 첫 실행 시 `git shortlog -sne` 결과에서 사용자가 직접
  자기 identity를 선택해야 하며, 이 플러그인이 임의로 "이 커밋은 당신 것"이라고 판단하지 않는다.
- 위 "명령" 절에 표시했듯, 이 README가 기술하는 기능 대부분은 **아직 구현되지 않았다** (Phase 0-A
  시점 — 레포 기반과 명명·라이선스 정본만 확정된 상태).

## 라이선스

[MIT](./LICENSE)
