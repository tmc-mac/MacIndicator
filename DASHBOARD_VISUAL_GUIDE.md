# AYCE ATH Dashboard Visual Layout

```
╔═══════════════════════════════════════════════╗
║        AYCE ATH STRATEGY                      ║
╠═════════════════════╦═════════════════════════╣
║ State               ║ Setup Active            ║
╠═════════════════════╬═════════════════════════╣
║ Signal              ║ LONG                    ║
╠═════════════════════╬═════════════════════════╣
║ Day                 ║ 01/25/2026              ║
╠═════════════════════╬═════════════════════════╣
║ Level               ║ 21458.25                ║
╠═════════════════════╩═════════════════════════╣
║           12HR MIYAGI                         ║
╠═════════════════════╦═════════════════════════╣
║   Levels            ║ 21450.00                ║
╠═════════════════════╬═════════════════════════╣
║   Pattern           ║ 2DOWN Live              ║
╠═════════════════════╬═════════════════════════╣
║   Bias              ║ Bullish                 ║
╠═════════════════════╩═════════════════════════╣
║         4HR RE-TRIGGER                        ║
╠═════════════════════╦═════════════════════════╣
║   Levels            ║ 21480.00 / 21420.00     ║
╠═════════════════════╬═════════════════════════╣
║   Pattern           ║ Valid CALL Setup        ║
╠═════════════════════╬═════════════════════════╣
║   Bias              ║ Bullish                 ║
╠═════════════════════╬═════════════════════════╣
║ Pref                ║ Prime                   ║
╠═════════════════════╬═════════════════════════╣
║ Pullback            ║ Moderate                ║
╠═════════════════════╬═════════════════════════╣
║ Structure           ║ Bullish                 ║
╠═════════════════════╬═════════════════════════╣
║ Volume              ║ High                    ║
╠═════════════════════╬═════════════════════════╣
║ Overall Bias        ║ Bullish                 ║
╠═════════════════════╬═════════════════════════╣
║ Confidence          ║ 85%                     ║
╚═════════════════════╩═════════════════════════╝
```

## Dashboard Color Coding

### State Row
- Background: Default dark
- Text: White

### Signal Row  
- **LONG**: Green text
- **SHORT**: Red text
- **Watch/Pending**: Yellow text
- **None**: Gray text

### Day Row
- Text: White

### Level Row
- Text: Yellow (highlights current price)

### 12HR MIYAGI Section
- Header: Purple background (70% transparency)
- Levels: Yellow text
- Pattern: White text
- Bias: 
  - Bullish = Green
  - Bearish = Red
  - Neutral = Gray

### 4HR RE-TRIGGER Section
- Header: Orange background (70% transparency)
- Levels: Yellow text
- Pattern: White text
- Bias:
  - Bullish = Green
  - Bearish = Red
  - Neutral = Gray

### Pref (Preference)
- **Prime**: Green text
- **Active**: Yellow text
- **Off-Hours**: Gray text

### Pullback
- Text: White

### Structure
- **Bullish**: Green text
- **Bearish**: Red text
- **Neutral**: Gray text

### Volume
- **High**: Green text
- **Above Avg**: Yellow text
- **Below Avg**: Gray text

### Overall Bias
- **Bullish**: Green text
- **Bearish**: Red text
- **Neutral**: Gray text

### Confidence
- **70-100%**: Green text (HIGH)
- **40-69%**: Yellow text (MODERATE)
- **0-39%**: Red text (LOW)

---

## Example Scenarios

### Scenario 1: Perfect Setup
```
State: Setup Active
Signal: LONG (GREEN)
12HR Bias: Bullish (GREEN)
4HR Bias: Bullish (GREEN)
Pref: Prime (GREEN)
Volume: High (GREEN)
Structure: Bullish (GREEN)
Overall Bias: Bullish (GREEN)
Confidence: 90% (GREEN)
```
**Action:** Take full position long

---

### Scenario 2: Mixed Signals
```
State: Forming
Signal: Watch (YELLOW)
12HR Bias: Bullish (GREEN)
4HR Bias: Bearish (RED)
Pref: Active (YELLOW)
Volume: Below Avg (GRAY)
Structure: Neutral (GRAY)
Overall Bias: Neutral (GRAY)
Confidence: 35% (RED)
```
**Action:** Wait, no trade

---

### Scenario 3: High Confidence Short
```
State: In Trade
Signal: SHORT (RED)
12HR Bias: Bearish (RED)
4HR Bias: Bearish (RED)
Pref: Prime (GREEN)
Volume: High (GREEN)
Structure: Bearish (RED)
Overall Bias: Bearish (RED)
Confidence: 85% (GREEN)
```
**Action:** Holding short position, manage exits

---

### Scenario 4: Moderate Setup
```
State: Setup Active
Signal: LONG (GREEN)
12HR Bias: Neutral (GRAY)
4HR Bias: Bullish (GREEN)
Pref: Active (YELLOW)
Volume: Above Avg (YELLOW)
Structure: Bullish (GREEN)
Overall Bias: Bullish (GREEN)
Confidence: 55% (YELLOW)
```
**Action:** Consider half position long

---

## Screen Positioning Options

The dashboard can be placed in 9 positions:

```
┌─────────────┬─────────────┬─────────────┐
│             │             │             │
│  TOP_LEFT   │ TOP_CENTER  │  TOP_RIGHT  │
│             │             │             │
├─────────────┼─────────────┼─────────────┤
│             │             │             │
│ MIDDLE_LEFT │MIDDLE_CENTER│MIDDLE_RIGHT │
│             │             │             │
├─────────────┼─────────────┼─────────────┤
│             │             │             │
│ BOTTOM_LEFT │BOTTOM_CENTER│BOTTOM_RIGHT │
│             │             │             │
└─────────────┴─────────────┴─────────────┘
```

**Recommended:** TOP_RIGHT (doesn't obscure price action)

---

## Size Options

### TINY
- Very small, minimal screen space
- Hard to read on small monitors
- Best for: Large screens with multiple indicators

### SMALL  
- Compact but readable
- Good balance of space and visibility
- Best for: Most users

### NORMAL (Recommended)
- Clear and easy to read
- Moderate screen space
- Best for: Single indicator use

### LARGE
- Very clear, large text
- Takes significant screen space
- Best for: Primary focus indicator, large monitors

### HUGE
- Maximum visibility
- Takes major screen space
- Best for: Presentation mode, teaching, very large displays

---

## Mobile/Tablet Considerations

On smaller screens:
- Use SMALL or TINY size
- Position at BOTTOM_RIGHT or BOTTOM_LEFT
- Focus on key fields: Signal, Overall Bias, Confidence
- Enable alerts for entry signals instead of watching dashboard

---

## Dashboard + Chart Integration

### With Levels Displayed
The dashboard works in conjunction with visual levels:

```
       Chart Price Action
    ╱───────────────────────╲
   │  Price moving up...     │
   │                         │
   │  ---- Purple Line ----  │ ← 12HR Miyagi Trigger
   │                         │
   │  .... Orange Line ....  │ ← 4HR Entry Level (high)
   │                         │
   │  .... Orange Line ....  │ ← 4HR Entry Level (low)
   │                         │
    ╲───────────────────────╱

    Dashboard (Top Right)
    Shows: All strategy states
```

### Recommended Layout
1. **Top Right:** Dashboard
2. **On Chart:** Key level lines
3. **Bottom:** Volume panel
4. **Side Panel:** Order entry/management

This keeps price action clear while having all info accessible.

---

## Tips for Reading the Dashboard

### 1. Quick Scan Priority (Top to Bottom)
1st: Signal (LONG/SHORT?)
2nd: Confidence (High enough?)
3rd: Overall Bias (Confirming?)
4th: Pref (Good time?)
5th: Individual strategies (Why?)

### 2. Pre-Market Routine
- Check 12HR Miyagi levels
- Monitor 4HR Re-Trigger pattern
- Note if State changes to "Setup Active"
- Prepare orders at trigger levels

### 3. Market Open Focus
- Signal for entry direction
- Confidence for position size
- Volume for conviction
- Overall Bias for confirmation

### 4. In-Trade Monitoring
- Watch Pattern fields for "60m Flip Exit"
- Monitor Confidence (if drops significantly, consider exit)
- Track Volume (continuation or exhaustion?)
- Structure (still aligned?)

### 5. End-of-Day Review
- Which setups triggered?
- What was confidence at entry?
- Did strategy alignment matter?
- Time of day impact?

---

## Troubleshooting Visual Issues

### Dashboard Not Visible
1. Check "Show Dashboard" setting = ON
2. Verify position setting (not off-screen)
3. Try different positions
4. Increase size if too small

### Text Too Small/Large
1. Adjust "Dashboard Size" setting
2. NORMAL is usually best
3. Scale based on monitor resolution

### Colors Hard to See
1. Adjust TradingView theme (dark/light)
2. Colors auto-adjust to theme
3. Check monitor brightness/contrast

### Overlapping Chart Elements
1. Move dashboard to different position
2. Reduce size
3. Minimize other indicators
4. Use full-screen chart mode

### Dashboard Updates Slowly
1. Normal - updates on bar close
2. Use alerts for immediate notifications
3. Refresh chart if frozen
4. Check internet connection

---

**Remember:** The dashboard is your mission control. Learn to read it at a glance, and you'll have an edge over traders using multiple separate indicators.
