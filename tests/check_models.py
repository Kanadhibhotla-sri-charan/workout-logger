import google.generativeai as genai

API_KEY = "AIzaSyDaNrZJQIcnQr5H2xOprhn6NwpNNtr33fM"
genai.configure(api_key=API_KEY)

print("Listing available models...")
try:
    for m in genai.list_models():
        if 'generateContent' in m.supported_generation_methods:
            print(f"- {m.name}")
except Exception as e:
    print(f"Error listing models: {e}")
