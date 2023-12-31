# -*- coding: utf-8 -*-

import os
import pickle
from operator import itemgetter

from langchain.document_loaders.sitemap import SitemapLoader

from langchain.vectorstores import Chroma
from langchain.embeddings import FastEmbedEmbeddings, OllamaEmbeddings
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain.vectorstores.utils import filter_complex_metadata

from langchain.callbacks.manager import CallbackManager
from langchain.callbacks.streaming_stdout import StreamingStdOutCallbackHandler
from langchain.schema.output_parser import StrOutputParser
from langchain_core.runnables import RunnableLambda, RunnablePassthrough
from langchain.chat_models import ChatOllama
from langchain.prompts import PromptTemplate
from langchain.memory import ConversationBufferMemory

class Gigi:
    chain = None
    memory = None

    def __init__(self, model_name):
        docs = []
        chroma_db_dir = "./chroma_db"

        #embeddings = OllamaEmbeddings(model=model_name)
        embeddings = FastEmbedEmbeddings()
        model = ChatOllama(model=model_name, callback_manager=CallbackManager([StreamingStdOutCallbackHandler()]))
        prompt = PromptTemplate.from_template(
            """
            <s> [INST] You are Gigi, an assistant for answering questions about the City of Garden Grove. 
            Use the following retrieved context to answer the questions. If you unsure of the answer, 
            just say that you don't know. If the question is irrelevent to the City of Garden Grove, 
            refuse to answer. Keep the answers concise and use 4 sentences max. Don't ask for follow up questions.
            Your context is the City's website. Always cite sources and help users navigate the website to the
            right web URL. [/INST] </s>

            Previous conversation: {history}

            [INST] Question: {question} 
            Context: {context} 
            Answer:[/INST]
            """
        )

        # if db has been persisted, use it
        if os.path.exists(chroma_db_dir):
            vectorstore = Chroma(
                embedding_function=embeddings,
                persist_directory=chroma_db_dir
            )
        else:
            print("No persisted DB, populating vector database. This could take a while.")

            # Load source data, GG website
            source_data = "source-data.pkl"
            if os.path.exists(source_data):
                with open(source_data, "rb") as f:
                    docs = pickle.load(f)
            else:
                sitemap_loader = SitemapLoader(web_path="https://ggcity.org/sitemap.xml")
                docs = sitemap_loader.load();    
                with open(source_data, "wb") as f:
                    pickle.dump(docs, f)

            # Chunk
            text_splitter = RecursiveCharacterTextSplitter(chunk_size=1024, chunk_overlap=100)
            chunks = text_splitter.split_documents(docs)
            chunks = filter_complex_metadata(chunks)
            vectorstore = Chroma.from_documents(documents=chunks, embedding=embeddings, persist_directory=chroma_db_dir)
            vectorstore.persist()

        retriever = vectorstore.as_retriever(
            search_type="similarity_score_threshold",
            search_kwargs={
                "k": 3,
                "score_threshold": 0.5,
            },
        )

        self.memory = ConversationBufferMemory()
        self.chain = (
            {"context": retriever, "question": RunnablePassthrough(), "history": (RunnableLambda(self.memory.load_memory_variables) | itemgetter("history"))}
            | prompt
            | model
            | StrOutputParser()
        )

    def with_history(self, history):
        if len(history) == 0:
            return
        
        most_recent_history = history[-1]
        self.memory.chat_memory.add_user_message(most_recent_history[0])
        self.memory.chat_memory.add_ai_message(most_recent_history[1])
        print(self.memory.load_memory_variables({}))

    def chat(self, msg):
        return self.chain.invoke(msg)

    def stream(self, msg):
        return self.chain.stream(msg)
