import requests
import pandas as pd
from datetime import datetime, timedelta
import sys
import os

BINANCE_URL = "https://api.binance.us/api/v3/klines"

def fetch_market_data(symbol):
    print(f"Fetching daily {symbol} candles from Binance for the last ~3 years...")

    # Binance uses milliseconds timestamps
    end_time = int(datetime.now().timestamp() * 1000)
    # Fetch ~1000 days of data (approx 3 years)
    start_time = int((datetime.now() - timedelta(days=1000)).timestamp() * 1000)

    params = {
        "symbol": symbol,
        "interval": "1d",
        "startTime": start_time,
        "endTime": end_time,
        "limit": 1000
    }

    response = requests.get(BINANCE_URL, params=params)

    if response.status_code != 200:
        print("Error:", response.text)
        return False

    candles = response.json()
    print(f"Data points received: {len(candles)}")

    if not candles:
        print("No data received.")
        return False

    # Binance returns array:
    # [ open_time, open, high, low, close, volume, close_time, ...]

    df = pd.DataFrame(candles, columns=[
        "open_time",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "close_time",
        "quote_asset_volume",
        "number_of_trades",
        "taker_buy_base",
        "taker_buy_quote",
        "ignore"
    ])

    # Convert types
    df["open"] = df["open"].astype(float)
    df["high"] = df["high"].astype(float)
    df["low"] = df["low"].astype(float)
    df["close"] = df["close"].astype(float)
    df["volume"] = df["volume"].astype(float)

    # Convert timestamps
    df["timestamp"] = pd.to_datetime(df["open_time"], unit="ms")

    df = df.sort_values("timestamp")

    # Save file
    filename = f"market_data_{symbol}.csv"
    df.to_csv(filename, index=False)
    print(f"Saved {filename}")
    return True

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python data_collector.py <SYMBOL>")
        sys.exit(1)
    
    symbol = sys.argv[1]
    fetch_market_data(symbol)
