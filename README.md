# Gigi - GG Chatbot

## Prerequisites

You'll need `ollama` and a model installed. I've tested with Dolphin Mistral 7B and Llama 2 13B-chat. The latter seems to give more detailed answers.

## Get started

```
$ python -m venv venv
$ source venv/bin/activate
$ pip install -r requirements.txt
$ python
Python 3.11.6 (main, Nov 14 2023, 09:36:21) [GCC 13.2.1 20230801] on linux
Type "help", "copyright", "credits" or "license" for more information.
>>> from chatbot import Gigi
>>> gigi = Gigi("dolphin.mistral")
Loading source data
No persisted DB, populating vector database. This could take a while.

>>> gigi.chat("who is the city manager?")
' Lisa Kim is the City Manager of Garden Grove.'

>>> gigi.chat("how can i pay water bill?")
" To pay your water bill, you can call (888) 867-2992 or visit the Water Billing section of the City of Garden Grove's website at https://ggcity.org/finance/water-billing. You can also start water service by calling Water Billing at (714) 741-5078, providing your information, and making a deposit if necessary."

>>> gigi.chat("how can i get in touch with code enforcement?")
' To get in touch with code enforcement, you can contact them by phone at (714) 741-5358 or send an email to codeenforcement@ggcity.org. You can also visit the Garden Grove City Hall at 11222 Acacia Parkway, Garden Grove, CA 92840 during their regular hours of operation: Monday through Thursday from 7:30 AM to 5:30 PM and alternating Fridays from 7:30 AM to 5:00 PM (closed on December 25-January 1).'

>>> gigi.chat("how do i apply for a job?")
' To apply for a job in Garden Grove, first you need to meet one of the following requirements: (a) be a senior in high school, (b) have a high school diploma, GED, or equivalent, (c) have a high school diploma, GED, or equivalent and enrolling in college in the next possible school term, or (d) be currently enrolled in college.\n\nIf you are interested in joining the police department, follow the hiring process which includes an application screening, written test (POST PELLETB), interview, background check, pre-employment medical examination. The selection process takes approximately 180 days from initial application to final selection/hiring.\n\nFor other job opportunities in Garden Grove, apply online or contact the appropriate department. Some departments may require additional qualifications and training'

>>> gigi.chat("i got a notice of violation. what do i do?")
" Based on the provided context, I can assist you with answering questions related to the City of Garden Grove's code enforcement and compliance processes.\n\nQuestion: What should I do if I receive a notice of violation?\n\nAnswer: If you receive a notice of violation from the City of Garden Grove, you should take immediate action to resolve the issue and avoid further penalties. The notice will provide instructions on how to comply with the code violation, and you may be given a deadline to complete the necessary corrections. It is essential to take the notice seriously and respond promptly to avoid additional fines or legal action.\n\nIf you have any questions or concerns about the notice of violation, you can contact the City of Garden Grove's Code Enforcement Department for assistance. They can provide information on how to resolve the issue and answer any questions you may have."

>>> gigi.chat("how do i make a pecan pie?")
UserWarning: No relevant docs were retrieved using the relevance score threshold 0.5
  warnings.warn(
' To make a pecan pie, follow these steps:\n\n1. Preheat your oven to 350°F (175°C).\n2. In a large bowl, whisk together sugar, butter, eggs, and vanilla extract until smooth.\n3. Add corn syrup, salt, and flour to the mixture, mixing well.\n4. Stir in the chopped pecans.\n5. Pour the filling into an unbaked pie crust.\n6. Bake for 1 hour or until a knife inserted in the center comes out clean.\n7. Cool completely before serving.'
```

## TODO

What isn't TODO at this point...

- Streaming output