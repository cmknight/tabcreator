# Tab format

v1 shows notes in played order with spacing roughly proportional to time; no note durations. Exact spacing and wrapping rules: story US-6.1.

**Bar lines (CAP-24)** — when the take has a count-in tempo, a `|` is drawn across all six lines at each bar boundary (4 beats, 4/4 assumed, bar 1 at capture start). No bar lines without a count-in.

Golden sample (notes 125 ms apart):

```
e|-----------------0-3-5-3-0--------|
B|-------------1-3-----------3-1----|
G|-------0-2-4----------------------|
D|---2-4----------------------------|
A|-3--------------------------------|
E|----------------------------------|
```

**.txt export** — wraps at 80 characters per line; header with title, tuning and date.
