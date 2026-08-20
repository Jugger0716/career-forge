# Project: DevCareer Prep (Claude Code Plugin)

> 사용자 원문 입력 (verbatim). `/harness` 세션의 요구사항 원본이며, 이후 산출되는
> `spec.md`(합성된 실행 스펙)와는 별개 문서다.

## Vision
Claude Code 플러그인으로, 개발자의 Git 히스토리를 분석해 경력 기술서를 자동 생성하고,
이를 기반으로 필요한 기술 지식을 추출한 뒤 갭을 분석하여 맞춤 학습 가이드와 코딩테스트 문제를 제공하는
개인화 면접·성장 도우미.

목표 사용자: AI를 적극 활용하지만 근본 지식이 부족한 백엔드 개발자 (특히 취업/이직 준비생)

핵심 가치: "내가 실제로 한 일"을 기반으로 부족한 부분을 정확히 찾고, 공부와 연습까지 연결한다.

## Goals (MVP)
1. 로컬/원격 Git 레포 분석 → 구조화된 경력 기술서 생성
2. 경력 기술서 기반 필요 기술 지식 추출 (필수/권장/심화)
3. 사용자 현재 수준과의 갭 분석
4. 우선순위 공부 가이드 + 관련 코딩테스트 문제 생성
5. 강력한 할루시네이션 방지 (멀티 에이전트 검증 + 출처 인용)

## Non-Goals (MVP에서 제외)
- 완전한 모의 면접 음성 대화
- 웹 UI (플러그인 내 인터랙션으로 충분)
- 다른 LLM 지원 (Claude 우선)
- 자동 이력서 PDF 생성

## Core Features (Priority Order)

### P0 - Must Have
- `/career-from-git` : Git 히스토리 분석 → 경력 기술서 초안 생성
- 경력 기술서 수정/보완 인터페이스
- `/skill-gap` : 경력 기반 필요 지식 추출 + 갭 리포트
- `/prep-plan` : 맞춤 공부 우선순위 + 추천 코딩테스트 문제 생성

### P1 - Should Have
- 문제 풀이 후 채점 및 상세 피드백 (`/grade`)
- 팩트체크 강제 (모든 지식 설명에 출처 또는 근거 커밋 제시)
- 진행 상황 저장 (로컬 파일 또는 간단한 SQLite)

### P2 - Nice to Have
- 시스템 디자인 문제 생성
- 면접 꼬리질문 생성
- 여러 레포 통합 분석

## Architecture

### Plugin Structure (Claude Code)
- Skills: career-analyzer, knowledge-extractor, gap-analyzer, problem-generator, grader
- Agents:
  - GitExtractor
  - CareerWriter
  - KnowledgeMapper
  - FactChecker (검증 전용)
  - CurriculumDesigner
- Slash Commands: 위에 정의된 명령어들
- Hooks: 필요 시 세션 시작 시 컨텍스트 로드
- 로컬 파일 저장: `.devcareer/` 디렉토리에 경력 기술서, 갭 리포트, 진행 상황 저장

### Data Flow
1. 사용자가 레포 경로 또는 GitHub URL 제공
2. GitExtractor가 log, diff, 파일 변경 이력 수집
3. CareerWriter가 구조화된 경력 기술서 생성 → 사용자 검토/수정
4. KnowledgeMapper가 경력에서 필요 지식 추출
5. GapAnalyzer가 사용자 입력(자가진단 또는 퀴즈)과 비교
6. CurriculumDesigner가 공부 계획 + 문제 생성
7. FactChecker가 모든 출력물 검증

### Hallucination Prevention Rules (강제)
- 모든 사실적 주장은 Git 커밋 해시 또는 신뢰할 수 있는 출처를 인용해야 함
- FactChecker 에이전트가 최종 승인하지 않으면 출력하지 않음
- "확실하지 않으면 '근거 부족'이라고 명시" 규칙 적용
- RAG: 주요 CS 문서, 공식 문서 임베딩 (선택적)

## Suggested File Structure

```
devcareer-prep/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── career-from-git/
│   ├── skill-gap/
│   ├── prep-plan/
│   └── grade/
├── agents/
│   ├── git-extractor.md
│   ├── career-writer.md
│   ├── knowledge-mapper.md
│   ├── fact-checker.md
│   └── curriculum-designer.md
├── prompts/
│   └── (핵심 프롬프트 모음)
├── schemas/
│   ├── career.md
│   ├── knowledge-map.md
│   └── gap-report.md
├── examples/
├── README.md
└── LICENSE
```

## Implementation Roadmap (추천 순서)

### Phase 1 (1주)
- 플러그인 기본 골격 + `/career-from-git` 구현
- Git 로그/diff 수집 및 경력 기술서 초안 생성
- 사용자 수정 루프

### Phase 2 (1주)
- KnowledgeMapper + GapAnalyzer
- `/skill-gap` 명령 완성

### Phase 3 (1주)
- CurriculumDesigner + 문제 생성
- `/prep-plan` 완성
- FactChecker 강화

### Phase 4
- 채점 기능, 문서화, 오픈소스 공개 준비
- 본인 실제 레포로 dogfooding 및 개선

## Success Criteria
- 본인 Git 히스토리로 경력 기술서를 생성했을 때 "이 정도면 실제로 쓸 수 있다" 수준
- 갭 분석 결과가 "공감되고 우선순위가 명확하다"고 느껴질 것
- 생성된 코딩테스트 문제가 실제 경력과 논리적으로 연결될 것
- 할루시네이션으로 인한 잘못된 지식 설명이 거의 없을 것

## Open Source Plan
- License: MIT 또는 Apache-2.0
- GitHub 공개 후 README에 설치 방법, 데모 GIF, 아키텍처 다이어그램 포함
- 나중에 claude-plugins-community 제출 목표

## 개발 시작 시 Claude Code에게 할 첫 지시 예시
"이 SPEC.md를 기반으로 DevCareer Prep Claude Code 플러그인 개발을 시작한다.
먼저 플러그인 기본 구조와 `/career-from-git` 스킬부터 만들어줘.
GitPython 또는 내장 git 명령어를 활용하고, 출력은 한국어 경력 기술서 형식으로 해."
