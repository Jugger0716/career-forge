---
name: career-from-git
description: 이 스킬은 Git 커밋 히스토리를 읽어 경력 기술서를 생성할 때 사용한다.
---

# 접두사가 어긋난 슬래시 명령을 안내하는 SKILL.md

negative 픽스처(케이스 29). 이 문서는 자기 명령을 `/wrongprefix:career-from-git`
으로 안내하는데, plugin.json의 name에서 파생되는 접두사는 그것이 아니다.

**케이스 11과 무엇이 다른가.** 11은 `docs/` 문서에서 같은 위반을 관측한다.
스캔 대상이 README·docs·SKILL.md 셋인데 SKILL.md 갈래만 대상 0건이었다 —
그리고 사용자가 실제로 복사해 붙여 넣는 명령 표기는 대개 SKILL.md에 있다.
