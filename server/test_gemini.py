import os
import requests
from dotenv import load_dotenv

load_dotenv()

api_key = os.getenv("MODEL_API_KEY")
model = os.getenv("MODEL_NAME")

url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

payload = {
    "contents": [
        {
            "parts": [
                {"text": "Reply with exactly: GEMINI WORKS"}
            ]
        }
    ]
}

response = requests.post(url, json=payload)

print("STATUS:", response.status_code)
print("RESPONSE:")
print(response.text)