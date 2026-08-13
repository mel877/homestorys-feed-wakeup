---
name: Discount bucket boundaries (inclusive upper bound, contiguous ranges)
description: All discount bucket upper bounds are inclusive; the 51_70 bucket max is 69 so exactly 70% falls into 70_plus.
---

## Rule
`assignDiscountBucket` uses **inclusive** upper bounds (`pct <= band.max`). The DISCOUNT_BUCKETS config defines:
- `none`: max=0
- `1_10`: max=10
- `11_20`: max=20
- `21_30`: max=30
- `31_50`: max=50
- `51_70`: max=69  ← stops at 69 so 70% falls into the next bucket
- `70_plus`: max=null

**Why:** A 10% discount must land in `1_10`, not fall through to `70_plus`. Setting 51_70 max=69 with inclusive checking means 70 is NOT in 51_70, and correctly lands in 70_plus (which has min=70).

**How to apply:** Use `pct <= band.max` in the loop. Keep `51_70.max = 69` in the config constant — do not raise it to 70.
