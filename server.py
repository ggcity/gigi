import time
import gradio as gr
from chatbot import Gigi

def talk_to_gigi(message, history):
    response = ""
    gigi.with_history(history)
    for chunk in gigi.stream(message):
        response += chunk
        yield response

gigi = Gigi("llama2:13b-chat")
demo = gr.ChatInterface(
    talk_to_gigi, 
    chatbot=gr.Chatbot(height=800),
    title="Gigi - Garden Grove Assistant"
).queue()

if __name__ == "__main__":
    demo.launch()