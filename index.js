/*
amtsblatt-gpt 🤖

Small bot that receives emails from the "Niedersächsische Verkündungsplattform" 
and summarizes the legal changes with ChatGPT and evaluates their relevance for 
the housing industry. The results are to be treated with care. 
Any warranty is completely excluded!

*/

const primer = { "role": "system", 
"content": 'Du bist ein deutschsprachiger Assistent, der neue Gesetze und Normen zusammenfasst. Du erhälst Anfrafgen mit Volltexten \
der neuen Gesetze und sollst sie in zwei Sätzen zusammenfassen. In einer neuen Zeile schreibst du einen kurzen Satz, ob die Gesetzesänderung\
 relevant für Wohnungsunternehmen oder die Immobilienwirtschaft ist. Wenn das Gesetz relevant sein könnte, schreibe "Achtung! Das Gesetz könnte \
 relevant für die Wohnungswirtschaft sein." und begründe kurz, warum du es für relevant hältst.' }

const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const Imap = require('node-imap'), inspect = require('util').inspect;
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const checkIntervalSeconds = process.env.CHECK_EMAIL_INTERVAL || 60; // Default to 60 seconds

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
  console.error("Environment variables EMAIL_USER and/or EMAIL_PASSWORD missing.");
  process.exit(-1);
}

const openai = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY']
});

const imapConfig = {
  user: process.env.EMAIL_USER,
  password: process.env.EMAIL_PASSWORD,
  host: "webspace29.do.de",
  port: 993,
  tls: true
};

let urlLimit = process.env.URL_LIMIT || -1;

async function searchEmailsForLinks() {
  //console.log("Searching for emails at", new Date().toLocaleTimeString());

  const imap = new Imap(imapConfig);

  imap.once('ready', function() {
    imap.openBox('INBOX', false, function(err, box) {
      if (err) throw err;
      imap.search(['UNSEEN', ['SINCE', 'Feb 29, 2024']], function(err, results) {
        if (err || !results || results.length === 0) {
          //console.log('No unseen emails found.');
          imap.end();
          return;
        }

        const fetch = imap.fetch(results, { bodies: '', markSeen: true });

        fetch.on('message', function(msg, seqno) {
          console.log('Message #%d', seqno);
          msg.on('body', function(stream) {
            processParsedEmail(stream);
          });
          msg.on('end', function() {
            imap.addFlags(seqno.toString(), '\\Deleted', (err) => {
              if (!err) imap.expunge((err)=>{
                if (err) console.error('Error while deleting messages:', err);
              });
            });
          });
        });

        fetch.once('error', function(err) {
          console.log('Fetch error: ' + err);
        });

        fetch.once('end', function() {
          console.log('Done fetching all messages!');
          imap.end();
        });
      });
    });
  });

  imap.once('error', function(err) {
    console.log(err);
  });

  imap.once('end', function() {
    console.log('Connection ended');
  });

  imap.connect();
}

async function processParsedEmail(stream) {
  try {
    const parsed = await simpleParser(stream);
    const fromEmail = parsed.from.value[0].address;
    const originalHtml = parsed.html;
    const body = parsed.text || "";
    const links = body.match(/https:\/\/www.verkuendung-niedersachsen.de\/nds[^\s>]+/g) || [];
    const responses = [];

    console.log('Found links:', links);

    // Process each found link with processPDF
    for (const link of links) {
      if (urlLimit > 0 && urlLimit-- == 0) break;
      const response = await processPDF(link).catch(error => console.error(`Error processing PDF from ${link}:`, error));
      responses.push(response);
    }

    await sendResponseEmail(fromEmail, responses, originalHtml);

  } catch (error) {
    console.error('Error parsing mail:', error);
  }
}

async function sendResponseEmail(to, responses, originalHtml) {
  let emailBody ='<p><strong>Hinweis:</strong> Die nachfolgende Auflistung wurde durch ChatGPT-4 erstellt. Die Zusammenfassung sowie die Einschätzung der Relevanz kann fehlerhaft sein und sollte immer einem manuellen Überprüfungsprozess unterzogen werden. Quellcode: <a href="https://github.com/MrApe/mbi-gpt">github.com</a></p>'
  emailBody += '<p>Aktuelle Verkündigungen aus der angefragten eMail:</p>\n\n';
  responses.forEach((response, index) => {
    if (response) {
      emailBody += `<div><h3>${response.headline}</h3><p>${response.summary}</p><a href="${response.url}">zur Verkündigung</a></div>`;
    }
  });

  emailBody += `<h4>Ursprüngliche Nachricht:</h4>${originalHtml}`;

  let transporter = nodemailer.createTransport({
    host: "webspace29.do.de", // Your SMTP server
    port: 587,
    secure: false, // true for 465, false for other ports
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });

  let info = await transporter.sendMail({
    from: `"MBI Verkündigungs-Bot" <${process.env.EMAIL_USER}>`,
    to: to,
    subject: "Re: KI-Zusammenfassung aktueller Verkündigungen",
    html: emailBody,
  });

  console.log('Message sent: %s', info.messageId);
}

async function getChatGPTSummary(text) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        primer,
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
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--headless',
      '--disable-gpu',
      '--disable-dev-shm-usage'
    ]
  })
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle0' });

  const data = await page.evaluate(() => {
    const pdfLinks = Array.from(document.querySelectorAll('a'))
      .map(anchor => anchor.href)
      .filter(href => href.endsWith('.pdf'));

    const headline = document.querySelector('h4') ? document.querySelector('h4').innerText : 'No headline found';
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
    let summary = await getChatGPTSummary(text.text);
    summary = summary.replace(/\n/g, '<br>')
    console.log(`ChatGPT Summary:`, summary);

    cleanupSync();

    return {url, headline, summary };

  } catch (error) {
    console.error(`An error occurred processing ${url}:`, error.message);
  }
}

function cleanupSync() {
  const filePath = path.resolve(__dirname, 'downloaded.pdf');
  
  try {
    fs.unlinkSync(filePath);
    console.log('downloaded.pdf removed successfully.');
  } catch (err) {
    console.error('Error removing downloaded.pdf:', err);
  }
}

searchEmailsForLinks();

setInterval(() => {
  searchEmailsForLinks();
}, checkIntervalSeconds * 1000);
