# AYCE ATH Combined Strategy Indicator V1

## Overview
This Pine Script indicator combines three powerful reversal strategies into a unified dashboard for futures trading on MNQ, MES, MGC, and SIL.

## Three Integrated Strategies

### 1. 12-Hour Miyagi Strategy (1-3-1 Pattern)
**Timeframe:** 12-hour candles  
**Pattern:** Inside-Outside-Inside (1-3-1)  
**Entry Trigger:** 50% level of 3rd candle  
**Trade Management:** 60-minute flip invalidation

**Logic:**
- Candle 1 (4PM): Inside bar (1)
- Candle 2 (4AM): Outside bar (3) 
- Candle 3 (4PM): Inside bar (1) → establishes 50% trigger
- Candle 4 (4AM): Must be 2UP or 2DOWN
- Entry at market open (9:30 AM) when price hits trigger
- Invalidation: If 3rd candle becomes a 3-bar (breaks both high and low)

### 2. 4HR Re-Trigger Strategy (2-2 Reversal)
**Timeframe:** 4-hour candles  
**Pattern:** 2-candle reversal setup  
**Entry Trigger:** Break of 4AM candle high/low  
**Trade Management:** Immediate breakout entry

**Logic:**
- 4AM candle (4-8AM): Must be 2UP or 2DOWN (sets bias)
- 8AM candle (8AM-12PM): Must reverse (2DOWN→2UP or 2UP→2DOWN)
- Market open validation: Price must be on correct side
- Entry: Immediate break above/below 4AM candle
- Price target: 4PM candle high/low

### 3. 322 First Live Strategy (3-2-2 Reversal)
**Timeframe:** 1-hour candles  
**Pattern:** 3-2-2 reversal during 8-10AM window  
**Entry Trigger:** 10AM reversal of 9AM candle  
**Trade Management:** 60-minute flip invalidation

**Logic:**
- 8AM candle: Must be 3-bar (outside bar)
- 9AM candle: Must be 2UP or 2DOWN (sets reversal bias)
- 10AM candle: Entry on break of 9AM high/low
- Price target: 8AM 3-bar high/low
- Exit: 60-minute flip (break of recent 60m candle)

## Bar Notation System

The indicator uses a standardized bar classification:
- **1-bar (Inside):** High ≤ Previous High AND Low ≥ Previous Low
- **2-bar (Directional):** 
  - 2UP: High > Previous High AND Low ≥ Previous Low AND Close > Open
  - 2DOWN: High ≤ Previous High AND Low < Previous Low AND Close < Open
- **3-bar (Outside):** High > Previous High AND Low < Previous Low

## Dashboard Components

### State
- **Waiting:** No active setup
- **Forming:** Pattern beginning to develop
- **Setup Active:** Valid setup, waiting for entry
- **In Trade:** Position active

### Signal
- **None:** No clear direction
- **Pending:** Setup forming
- **Watch:** Setup valid, monitoring entry
- **LONG:** Bullish entry triggered
- **SHORT:** Bearish entry triggered

### 12HR Miyagi Section
- **Levels:** 50% trigger price from 3rd candle
- **Pattern:** Current pattern state (1-3-1 Valid, 2UP Live, etc.)
- **Bias:** Bullish/Bearish/Neutral direction

### 4HR Re-Trigger Section
- **Levels:** 4AM candle high/low
- **Pattern:** Setup state (4AM 2DOWN, Valid CALL Setup, etc.)
- **Bias:** Expected reversal direction

### Preference (Pref)
Time-of-day trading window quality:
- **Prime:** 9:00-11:00 AM (best setups)
- **Active:** 11:00 AM-3:00 PM (normal trading)
- **Off-Hours:** Before 9 AM or after 3 PM

### Pullback
Current retracement depth from recent extremes:
- **Shallow:** < 1 ATR
- **Moderate:** 1-2 ATR
- **Deep:** > 2 ATR

### Structure
Price structure based on higher highs/lower lows:
- **Bullish:** Making higher lows
- **Bearish:** Making lower highs
- **Neutral:** Consolidating

### Volume
Current volume compared to 20-period EMA:
- **High:** > 1.5x EMA (strong participation)
- **Above Avg:** > 1.0x EMA
- **Below Avg:** < 1.0x EMA

### Overall Bias
Aggregated directional bias from all active strategies:
- Calculated by averaging bias from all enabled strategies
- **Bullish:** Score > 0.3
- **Bearish:** Score < -0.3
- **Neutral:** Score between -0.3 and 0.3

### Confidence Score (0-100%)
Multi-factor confidence calculation:
- **40 points max:** Strategy alignment (all strategies agree)
- **20 points max:** Volume confirmation
- **20 points max:** Structure alignment with bias
- **10 points max:** Prime time window
- **10 points max:** Additional market conditions

**Interpretation:**
- **70-100%:** High confidence setup
- **40-69%:** Moderate confidence
- **0-39%:** Low confidence, wait for better setup

## Settings & Customization

### Strategy Selection
- Enable/disable individual strategies
- Run all three simultaneously or test individually

### Dashboard
- **Position:** 9 screen positions available
- **Size:** Tiny, Small, Normal, Large, Huge
- Toggle dashboard visibility

### Visual Settings
- Show/hide key levels on chart
- Show/hide pattern annotations
- Customizable colors for bullish/bearish/neutral

### Volume Settings
- EMA length (default: 20)
- High volume threshold multiplier (default: 1.5x)

## Chart Setup Requirements

### TradingView Requirements
1. **Extended Hours:** Must be ON
2. **Timezone:** Set to Eastern Time (or your preference)
3. **Data Package:** Requires TradingView's "US Stock Markets bundle" for extended hours data
   - Link: https://www.tradingview.com/data-coverage/

### Recommended Chart Setup
- **Primary Timeframe:** Use your trading timeframe (5m, 15m, 1H)
- **Overlay:** Indicator overlays on price chart
- **Extended Hours:** CRITICAL - strategies rely on 4AM candles

## How to Use

### Installation
1. Open TradingView
2. Pine Editor → New indicator
3. Paste the entire code
4. Save and add to chart

### For MNQ/MES/MGC/SIL
1. Open your futures contract chart
2. Enable extended hours
3. Set timezone to America/New_York
4. Add indicator
5. Adjust dashboard position/size as needed

### Trading Workflow

**Pre-Market (4-9:30 AM ET):**
1. Check if 4AM candle is 2UP or 2DOWN (4HR strategy)
2. Check if 8AM candle shows reversal
3. Monitor 12HR Miyagi levels if setup is active
4. Watch dashboard for "Setup Active" state

**Market Open (9:30 AM):**
1. Verify setup remains valid
2. Check Overall Bias and Confidence Score
3. Wait for entry trigger (price breaks key level)
4. Enter when Signal changes to LONG/SHORT

**During Trade:**
1. Monitor for 60-minute flip
2. Watch Structure and Volume for continuation signs
3. Take profit at target levels (shown in strategy docs)
4. Exit if dashboard shows "60m Flip Exit"

**Mid-Morning (10 AM):**
1. Watch for 322 First Live setup
2. 8AM must be 3-bar, 9AM must be 2-bar
3. Entry during 10AM hour on reversal

## Risk Management

### Position Sizing
- Use confidence score to scale position size
- Higher confidence = larger position (within risk limits)
- Below 40% confidence = skip or minimum size

### Stop Loss Guidelines
1. **12HR Miyagi:** Exit on 60-minute flip
2. **4HR Re-Trigger:** Stop below/above 8AM candle
3. **322 First Live:** Exit on 60-minute flip

### Take Profit Targets
1. **12HR Miyagi:**
   - TP1: High/Low of 3rd candle (1-bar)
   - TP2: High/Low of 2nd candle (3-bar)

2. **4HR Re-Trigger:**
   - TP: 4PM candle high/low

3. **322 First Live:**
   - TP: 8AM 3-bar high/low

## Alerts

The indicator includes four alert conditions:
1. **12HR Miyagi Entry:** Triggered when 12HR setup enters
2. **4HR Re-Trigger Entry:** Triggered when 4HR setup enters
3. **322 First Live Entry:** Triggered when 322 setup enters
4. **High Confidence Setup:** Triggered when confidence > 70%

### Setting Up Alerts
1. Click "Alert" button on TradingView
2. Select this indicator
3. Choose alert condition
4. Set notification preferences

## Tips for Best Results

### 1. Multi-Strategy Confluence
Best trades occur when 2+ strategies align:
- Example: 12HR Miyagi + 4HR Re-Trigger both bullish
- Dashboard shows higher confidence scores
- Overall Bias will be stronger

### 2. Volume Confirmation
- Entries with "High" volume have better follow-through
- Avoid trades during "Below Avg" volume unless high confidence

### 3. Time of Day Matters
- **Prime (9-11 AM):** Highest probability setups
- **Active (11 AM-3 PM):** Decent but less reliable
- **Off-Hours:** Avoid unless extreme confidence

### 4. Structure Alignment
Best trades align with Structure:
- Bullish bias + Bullish structure = strong setup
- Bearish bias + Bearish structure = strong setup
- Bias opposite to structure = lower probability

### 5. Monitor State Changes
- "Forming" → "Setup Active" = prepare for entry
- "Setup Active" → "In Trade" = position taken
- Watch for invalidation messages (60m flip, etc.)

## Backtesting Considerations

### Limitations
- Pine Script alerts trigger on bar close
- Real-time execution may differ from backtest
- Slippage and commissions not included

### Recommendations
1. Paper trade first to understand timing
2. Track results by strategy individually
3. Note which confluences work best for your instruments
4. Keep a journal of confidence scores vs outcomes

## Troubleshooting

### Dashboard Not Showing
- Check "Show Dashboard" is enabled
- Verify chart has sufficient history (need past 12-24 hours)

### No Patterns Detected
- Verify extended hours are ON
- Check timezone is set correctly
- Ensure data package is active
- Wait for proper candle formations

### Levels Not Plotting
- Enable "Show Key Levels on Chart"
- Ensure strategies are enabled
- Check that setups are active

## Future Enhancements (Planned)

- [ ] Add 322 strategy to dashboard (currently shows 12HR and 4HR only)
- [ ] Historical win rate tracking
- [ ] Multiple timeframe momentum alignment
- [ ] Automated position sizing calculator
- [ ] Enhanced invalidation rules
- [ ] Backtesting mode with statistics

## Version History

**V1 (Current)**
- Initial release
- Three strategies integrated
- Unified dashboard
- Confidence scoring system
- Volume and structure analysis

## Support & Feedback

This indicator is designed specifically for the AYCE ATH trading strategies. For questions about:
- **Strategy logic:** Reference the PDF documents
- **Code issues:** Check Pine Script documentation
- **Custom modifications:** Pine Script supports extensive customization

## Disclaimer

This indicator is for educational purposes. Past performance does not guarantee future results. Always use proper risk management and never risk more than you can afford to lose. Futures trading involves substantial risk of loss.

---

**Built for:** MNQ, MES, MGC, SIL futures traders  
**Timeframes:** Multi-timeframe (12HR, 4HR, 1HR)  
**Style:** Reversal-based strategies with confluence  
**Best Use:** Pre-market setup identification and market open execution
