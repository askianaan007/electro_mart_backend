

```bash
node dummy_scripts/01-create-investors.js     # creates the 4 dummy investors (skips any that already exist)
node dummy_scripts/02-create-investments.js   # creates 100 dummy Investment rows spread across them
node dummy_scripts/cleanup.js                 # removes every dummy investor + their investments
```

Run `01` before `02` — the second script looks up the dummy investors by their `Dummy Investor` name prefix.
Both `01` and `02` are safe to re-run: `01` skips investors that already exist by name, `02` always adds
another 100 (re-run only if you want more).
