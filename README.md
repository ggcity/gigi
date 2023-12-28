# Gigi - GG Chatbot

## Prerequisites

You'll need `ollama` and a model installed. I've tested with Dolphin Mistral 7B and Llama 2 13B-chat. The latter seems to give more detailed answers.

## Training data

Not really training, just RAG. Data are pulled from City's website via sitemap.xml.

## Get started

```
$ python -m venv venv
$ source venv/bin/activate
$ pip install -r requirements.txt
$ python server.py
```

Then open up to `http://localhost:7860`

## Sample responses

```
>>> gigi.chat("who is the city manager?")
' Lisa Kim is the City Manager of Garden Grove.'

>>> gigi.chat("how can i pay water bill?")
" To pay your water bill, you can call (888) 867-2992 or visit the Water Billing section of the City of Garden Grove's website at https://ggcity.org/finance/water-billing. You can also start water service by calling Water Billing at (714) 741-5078, providing your information, and making a deposit if necessary."

>>> gigi.chat("how can i get in touch with code enforcement?")
' To get in touch with code enforcement, you can contact them by phone at (714) 741-5358 or send an email to codeenforcement@ggcity.org. You can also visit the Garden Grove City Hall at 11222 Acacia Parkway, Garden Grove, CA 92840 during their regular hours of operation: Monday through Thursday from 7:30 AM to 5:30 PM and alternating Fridays from 7:30 AM to 5:00 PM (closed on December 25-January 1).'

>>> gigi.chat("how do i apply for a job?")
' To apply for a job in Garden Grove, first you need to meet one of the following requirements: (a) be a senior in high school, (b) have a high school diploma, GED, or equivalent, (c) have a high school diploma, GED, or equivalent and enrolling in college in the next possible school term, or (d) be currently enrolled in college.

If you are interested in joining the police department, follow the hiring process which includes an application screening, written test (POST PELLETB), interview, background check, pre-employment medical examination. The selection process takes approximately 180 days from initial application to final selection/hiring.

For other job opportunities in Garden Grove, apply online or contact the appropriate department. Some departments may require additional qualifications and training'

>>> gigi.chat("i got a notice of violation. what do i do?")
" Based on the provided context, I can assist you with answering questions related to the City of Garden Grove's code enforcement and compliance processes.

Question: What should I do if I receive a notice of violation?

Answer: If you receive a notice of violation from the City of Garden Grove, you should take immediate action to resolve the issue and avoid further penalties. The notice will provide instructions on how to comply with the code violation, and you may be given a deadline to complete the necessary corrections. It is essential to take the notice seriously and respond promptly to avoid additional fines or legal action.

If you have any questions or concerns about the notice of violation, you can contact the City of Garden Grove's Code Enforcement Department for assistance. They can provide information on how to resolve the issue and answer any questions you may have."

>>> gigi.chat("what are the requirements to build ADU?")
" Sure! Based on the provided context, I can answer your question.

To build an Accessory Dwelling Unit (ADU) in the City of Garden Grove, there are several requirements you need to be aware of. Here is a list of some of the key requirements:

1. Zoning Requirements: ADUs are subject to the same zoning requirements as the primary residence on the property. You can check the zoning map and the City's Zoning Ordinance to determine if your property is zoned for ADUs.
2. Building Codes: ADUs must comply with all applicable building codes, including the California Building Standards Code and the International Building Code.
3. Permit Requirements: You will need to obtain a building permit before constructing an ADU. The City of Garden Grove has a checklist of submittal requirements for ADU projects, which includes a completed application, site plan, electrical plan, and other documents.
4. Parking Requirements: ADUs are subject to the City's parking requirements, which may vary depending on the location and size of the unit.
5. Environmental Review: The City of Garden Grove requires an environmental review for ADU projects to ensure compliance with the California Environmental Quality Act (CEQA).
6. Landscaping Requirements: ADUs must meet the City's landscaping requirements, which include provisions for drought-tolerant plants and water-efficient irrigation systems.
7. Impact Fees: The City of Garden Grove charges impact fees for ADU projects, which are used to fund infrastructure improvements and other community needs.

It's important to note that these requirements may be subject to change, so it's always a good idea to check with the City of Garden Grove's Planning Department for the most up-to-date information before proceeding with your ADU project."

>>> gigi.chat("how do i make a pecan pie?")
UserWarning: No relevant docs were retrieved using the relevance score threshold 0.5
  warnings.warn(
' To make a pecan pie, follow these steps:

1. Preheat your oven to 350°F (175°C).
2. In a large bowl, whisk together sugar, butter, eggs, and vanilla extract until smooth.
3. Add corn syrup, salt, and flour to the mixture, mixing well.
4. Stir in the chopped pecans.
5. Pour the filling into an unbaked pie crust.
6. Bake for 1 hour or until a knife inserted in the center comes out clean.
7. Cool completely before serving.'
```

## TODO

What isn't TODO at this point...

- Cite sources
- Message history