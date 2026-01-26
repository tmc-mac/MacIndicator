# AYCE ATH Dashboard Quick Reference Card

## Dashboard Fields Explained

### STATE
Current operational status of the indicator:
- **Waiting** - No patterns forming
- **Forming** - Initial pattern development
- **Setup Active** - Valid setup, monitoring for entry
- **In Trade** - Position is active

### SIGNAL  
Trading direction recommendation:
- **None** - No clear trade direction
- **Pending** - Pattern developing
- **Watch** - Setup valid, wait for trigger
- **LONG** - Bullish entry triggered (green)
- **SHORT** - Bearish entry triggered (red)

### DAY
Current trading date (MM/DD/YYYY format)

### LEVEL
Current price of the instrument

---

## 12HR MIYAGI SECTION

### Levels
The 50% trigger price calculated from the 3rd candle (inside bar) in the 1-3-1 pattern.
- This is THE key entry level for the 12HR strategy
- Same level used for both CALLS and PUTS

### Pattern
Current state of the 1-3-1 candle sequence:
- **1-3-1 Valid** - All three candles confirmed, watching 4th
- **2UP Live** - 4th candle opened as 2UP (bearish reversal expected)
- **2DOWN Live** - 4th candle opened as 2DOWN (bullish reversal expected)
- **Invalidated** - Setup failed (3rd candle became outside bar)
- **60m Flip Exit** - Trade invalidated by 60-minute flip

### Bias
Expected trade direction:
- **Bullish** - Looking for CALL entry (green)
- **Bearish** - Looking for PUT entry (red)
- **Neutral** - No clear direction (gray)

---

## 4HR RE-TRIGGER SECTION

### Levels
Shows the 4AM candle high/low levels (format: "High / Low")
- **Bullish setup:** Entry is break above high
- **Bearish setup:** Entry is break below low

### Pattern
Current state of the 2-2 reversal setup:
- **4AM 2DOWN** - 4AM down, looking for reversal up
- **4AM 2UP** - 4AM up, looking for reversal down
- **2DOWN→2UP Rev** - Reversal confirmed, bullish bias
- **2UP→2DOWN Rev** - Reversal confirmed, bearish bias
- **Valid CALL Setup** - All conditions met for long entry
- **Valid PUT Setup** - All conditions met for short entry
- **CALL Entry** - Long position triggered
- **PUT Entry** - Short position triggered
- **No reversal** - 8AM candle didn't reverse

### Bias
Expected reversal direction:
- **Bullish** - Expect reversal up (green)
- **Bearish** - Expect reversal down (red)
- **Neutral** - No reversal setup (gray)

---

## PREF (Preference)
Time-of-day trading quality rating:
- **Prime** - 9:00-11:00 AM (BEST setups, highest priority) (green)
- **Active** - 11:00 AM-3:00 PM (Normal trading hours) (yellow)
- **Off-Hours** - Before 9 AM or after 3 PM (Low priority) (gray)

💡 *Tip: Focus on Prime time setups for best results*

---

## PULLBACK
Measures current retracement depth from recent price extremes:
- **Shallow** - Less than 1 ATR pullback
- **Moderate** - 1-2 ATR pullback
- **Deep** - Greater than 2 ATR pullback

💡 *Tip: Moderate pullbacks often provide best risk/reward entries*

---

## STRUCTURE
Overall price structure trend:
- **Bullish** - Making higher lows (green)
- **Bearish** - Making lower highs (red)  
- **Neutral** - Consolidating/choppy (gray)

💡 *Tip: Best trades align bias with structure (both bullish or both bearish)*

---

## VOLUME
Current volume compared to 20-bar EMA:
- **High** - Volume > 1.5x average (strong participation) (green)
- **Above Avg** - Volume > average but < 1.5x (yellow)
- **Below Avg** - Volume < average (weak participation) (gray)

💡 *Tip: High volume entries have better follow-through*

---

## OVERALL BIAS
Aggregated directional bias from ALL enabled strategies:
- **Bullish** - Multiple strategies showing upward bias (green)
- **Bearish** - Multiple strategies showing downward bias (red)
- **Neutral** - Mixed signals or no clear direction (gray)

**Calculation:** Average of all active strategy biases
- Best when 2+ strategies agree
- Strength increases with more aligned strategies

---

## CONFIDENCE SCORE
Multi-factor confidence rating (0-100%):

### Scoring Breakdown:
- **Strategy Alignment** (0-40 pts)
  - 40 pts: All strategies agree on direction
  - 20 pts: 2 strategies agree
  - 0 pts: No agreement or single strategy

- **Volume Confirmation** (0-20 pts)
  - 20 pts: High volume
  - 10 pts: Above average volume
  - 0 pts: Below average volume

- **Structure Alignment** (0-20 pts)
  - 20 pts: Bias matches structure direction
  - 0 pts: Bias conflicts with structure

- **Time Window** (0-10 pts)
  - 10 pts: Prime time (9-11 AM)
  - 0 pts: Other times

- **Additional Factors** (0-10 pts)
  - Market conditions, momentum, etc.

### Interpretation:
- **70-100%** 🟢 HIGH - Strong setup, full position sizing
- **40-69%** 🟡 MODERATE - Decent setup, reduced position sizing  
- **0-39%** 🔴 LOW - Weak setup, skip or minimal sizing

💡 *Tip: Only take trades with 50%+ confidence unless you have additional conviction*

---

## TRADING RULES SUMMARY

### Entry Requirements
✅ State = "Setup Active" or "In Trade"  
✅ Signal = "LONG" or "SHORT"  
✅ Confidence ≥ 50% (preferably 70%+)  
✅ Volume = "High" or "Above Avg"  
✅ Pref = "Prime" (ideal)  
✅ Structure aligns with Bias (ideal)

### Position Sizing by Confidence
- **70-100%:** Full position (100%)
- **50-69%:** Half position (50%)
- **Below 50%:** Skip or watch only

### Exit Signals
🛑 60m Flip indicated in pattern field  
🛑 Confidence drops significantly  
🛑 Take profit targets hit (see strategy PDFs)  
🛑 End of trading day (manage overnight risk)

### Best Setups (Highest Win Rate)
1. Multiple strategies aligned (Overall Bias strong)
2. Confidence score 70%+
3. Prime time window (9-11 AM)
4. High volume
5. Structure matches bias
6. Moderate pullback depth

---

## COMMON QUESTIONS

**Q: Why is Confidence low even though I see a pattern?**  
A: Confidence requires multiple factors: strategy alignment, volume, structure, and time window. A single pattern isn't enough.

**Q: Should I trade every signal?**  
A: No. Focus on 50%+ confidence, preferably 70%+. Quality over quantity.

**Q: Can I trade off-hours setups?**  
A: You can, but Prime time (9-11 AM) has significantly better odds.

**Q: What if Overall Bias shows Neutral?**  
A: Mixed signals. Wait for clarity or skip the trade.

**Q: When should I ignore a high confidence score?**  
A: If State shows "Forming" rather than "Setup Active", or if Signal is "Pending/Watch" rather than "LONG/SHORT".

---

## VISUAL CUES ON CHART

### Level Lines (when enabled)
- **Purple dashed line** - 12HR Miyagi trigger (50% level)
- **Orange dotted lines** - 4HR Re-Trigger levels (4AM high/low)

### Labels (when enabled)
- Pattern confirmations
- Entry/exit signals
- Invalidation warnings

---

**Pro Tip:** Print this reference card and keep it next to your trading screen. Quick glances at the dashboard combined with this reference will help you make faster, more confident decisions.

**Remember:** The dashboard synthesizes complex multi-strategy analysis into actionable information. Trust the confidence score—it's your edge.
