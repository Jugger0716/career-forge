---
name: career-from-git
---

# description이 없는 SKILL.md

frontmatter에 `name`은 있으나 `description`이 없는 negative 픽스처(케이스 25)다.
description은 Claude가 라우팅에 쓰는 값이므로, 없으면 스킬이 사실상 호출되지
않는다 — 조용히 통과시키면 그 사실이 실행 시점까지 드러나지 않는다.
