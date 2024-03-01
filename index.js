// index.js
const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY']
});

const urls = process.argv.slice(2);

async function getChatGPTSummary(text) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { "role": "system", "content": "Du bist ein deutschsprachiger Assistent, der neue Gesetze und Normen zusammenfasst. Du erhälst Anfrafgen mit Volltexten der neuen Gesetze und sollst sie in zwei Sätzen zusammenfassen." },
        { "role": "user", "content": text }
      ]
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error in getting response from ChatGPT:', error.message);
    return null;
  }
}

async function scrapePDFLinksAndHeadline(url) {
  const browser = await puppeteer.launch({headless: "new"});
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle0' });

  const data = await page.evaluate(() => {
    const pdfLinks = Array.from(document.querySelectorAll('a'))
      .map(anchor => anchor.href)
      .filter(href => href.endsWith('.pdf'));

    const headline = document.querySelector('h1') ? document.querySelector('h1').innerText : 'No headline found';
    return { pdfLinks, headline };
  });

  await browser.close();
  return data;
}

async function processPDF(url) {
  try {
    const { pdfLinks, headline } = await scrapePDFLinksAndHeadline(url);

    if (pdfLinks.length === 0) {
      throw new Error('No PDF links found on the page.');
    }

    const pdfUrl = pdfLinks[0];
    console.log(`Downloading PDF from: ${pdfUrl}`);
    const pdfResponse = await axios({
      method: 'get',
      url: pdfUrl,
      responseType: 'arraybuffer'
    });

    const pdfPath = path.resolve(__dirname, 'downloaded.pdf');
    fs.writeFileSync(pdfPath, Buffer.from(pdfResponse.data, 'binary'));

    const dataBuffer = fs.readFileSync(pdfPath);
    const text = await pdfParse(dataBuffer);

    console.log(`Text extraction complete for ${url}. Headline: ${headline}`);
    const summary = await getChatGPTSummary(text.text);
    console.log(`ChatGPT Summary:`, summary);

  } catch (error) {
    console.error(`An error occurred processing ${url}:`, error.message);
  }
}

urls.forEach(async url => {
  await processPDF(url);
});
