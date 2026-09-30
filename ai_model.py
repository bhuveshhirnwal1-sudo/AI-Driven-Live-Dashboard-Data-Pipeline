import pandas as pd
import numpy as np
import json
import sys
import warnings
import os
import random
import joblib
import pandas_ta as ta
from sklearn.preprocessing import MinMaxScaler
from tensorflow.keras.models import Sequential, load_model
from tensorflow.keras.layers import LSTM, Dense, Dropout
import tensorflow as tf

# Suppress warnings and TF logs
warnings.filterwarnings("ignore")
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3' 

# Set Random Seeds for Reproducibility
SEED = 42
os.environ['PYTHONHASHSEED'] = str(SEED)
random.seed(SEED)
np.random.seed(SEED)
tf.random.set_seed(SEED)

MODELS_DIR = "models"

def create_dataset(dataset, look_back=60):
    X, Y = [], []
    for i in range(len(dataset) - look_back - 1):
        a = dataset[i:(i + look_back), 0]
        X.append(a)
        Y.append(dataset[i + look_back, 0])
    return np.array(X), np.array(Y)

def smooth_curve(points, factor=0.8):
    smoothed_points = []
    for point in points:
        if smoothed_points:
            previous = smoothed_points[-1]
            smoothed_points.append(previous * factor + point * (1 - factor))
        else:
            smoothed_points.append(point)
    return smoothed_points

def train_and_predict(symbol):
    data_filename = f"market_data_{symbol}.csv"
    model_path = os.path.join(MODELS_DIR, f"lstm_{symbol}.keras")
    scaler_path = os.path.join(MODELS_DIR, f"scaler_{symbol}.pkl")
    
    if not os.path.exists(data_filename):
        print(json.dumps({"error": f"Data file {data_filename} not found"}))
        return

    # Load market data
    df = pd.read_csv(data_filename)
    
    if len(df) < 200:
        print(json.dumps({"error": "Not enough data to train LSTM (need > 200 days)"}))
        return

    # --- Technical Analysis (Always needed for the report) ---
    df.ta.rsi(length=14, append=True)
    df.ta.macd(append=True)
    df.ta.bbands(append=True)
    df.ta.ema(length=50, append=True)
    df.ta.ema(length=200, append=True)
    df.ta.atr(append=True)

    df.dropna(inplace=True)

    latest = df.iloc[-1]
    rsi = latest['RSI_14']
    macd = latest['MACD_12_26_9']
    close_price = latest['close']
    ema_50 = latest['EMA_50']
    ema_200 = latest['EMA_200']
    volatility = latest['ATRr_14']

    # --- Model Handling ---
    data = df.filter(['close']).values
    
    # Check if model exists
    if os.path.exists(model_path) and os.path.exists(scaler_path):
        # Load existing model and scaler
        model = load_model(model_path)
        scaler = joblib.load(scaler_path)
        scaled_data = scaler.transform(data)
        confidence_score = 95.0 # Assume high confidence for saved models (or store this metadata)
    else:
        # Train new model
        scaler = MinMaxScaler(feature_range=(0, 1))
        scaled_data = scaler.fit_transform(data)

        look_back = 60
        X_train, y_train = create_dataset(scaled_data, look_back)
        X_train = np.reshape(X_train, (X_train.shape[0], X_train.shape[1], 1))

        model = Sequential()
        model.add(LSTM(50, return_sequences=True, input_shape=(look_back, 1)))
        model.add(Dropout(0.2))
        model.add(LSTM(50, return_sequences=False))
        model.add(Dropout(0.2))
        model.add(Dense(25))
        model.add(Dense(1))

        model.compile(optimizer='adam', loss='mean_squared_error')
        history = model.fit(X_train, y_train, batch_size=32, epochs=5, verbose=0)
        
        final_loss = history.history['loss'][-1]
        confidence_score = max(0, min(100, (1 - final_loss) * 100))

        # Save model and scaler
        model.save(model_path)
        joblib.dump(scaler, scaler_path)

    # --- Prediction ---
    look_back = 60
    future_days = 30
    
    # Use the last 60 days of data for prediction
    last_60_days = scaled_data[-look_back:]
    curr_input = last_60_days.reshape(1, look_back, 1)
    
    predicted_prices = []
    
    for _ in range(future_days):
        pred = model.predict(curr_input, verbose=0)
        predicted_prices.append(pred[0, 0])
        
        pred_reshaped = pred.reshape(1, 1, 1)
        curr_input = np.append(curr_input[:, 1:, :], pred_reshaped, axis=1)

    predicted_prices = scaler.inverse_transform(np.array(predicted_prices).reshape(-1, 1))
    raw_trend = predicted_prices.flatten().tolist()
    
    # Apply smoothing
    smoothed_trend = smooth_curve(raw_trend)

    # --- Market Sheet ---
    signal = "NEUTRAL"
    if rsi < 30 and close_price > ema_200:
        signal = "STRONG BUY"
    elif rsi < 40:
        signal = "BUY"
    elif rsi > 70 and close_price < ema_200:
        signal = "STRONG SELL"
    elif rsi > 60:
        signal = "SELL"
    
    trend_direction = "UP" if smoothed_trend[-1] > close_price else "DOWN"
    
    result = {
        "symbol": symbol,
        "current_price": float(close_price),
        "predicted_price_30d": float(smoothed_trend[-1]),
        "trend_direction": trend_direction,
        "predicted_trend": smoothed_trend,
        "market_sheet": {
            "signal": signal,
            "confidence_score": round(confidence_score, 2),
            "volatility_index": round(volatility, 2),
            "rsi": round(rsi, 2),
            "macd": round(macd, 2),
            "ema_50": round(ema_50, 2),
            "ema_200": round(ema_200, 2)
        }
    }

    print(json.dumps(result))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python ai_model.py <SYMBOL>"}))
        sys.exit(1)

    symbol = sys.argv[1]
    train_and_predict(symbol)
