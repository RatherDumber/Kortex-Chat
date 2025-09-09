from openai import OpenAI
import sys
import json

client = OpenAI(
    api_key="api key not set up (it is setup but removed for security reasons but the api key will work during hosting the server. This text will be replaced with the actual key after i commit the change)",
    base_url="https://api.sambanova.ai/v1",
)

def get_ai_response(messages):
    response = client.chat.completions.create(
        model="Qwen3-32B",
        messages=messages,
        temperature=0.1,
        top_p=0.1
    )
    return response.choices[0].message.content

if __name__ == "__main__":
    # Accept messages as JSON from stdin
    try:
        messages = json.loads(sys.stdin.read())
        output = get_ai_response(messages)
        print(output)
    except Exception as e:
        print(f"Error: {e}")