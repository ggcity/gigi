import time
import gradio as gr
from chatbot import Gigi

def talk_to_gigi(message, history):
    print(history)
    response = ""
    for chunk in gigi.stream(message):
        response += chunk
        yield response

gigi = Gigi("llama2:13b-chat")
demo = gr.ChatInterface(talk_to_gigi).queue()

if __name__ == "__main__":
    demo.launch()