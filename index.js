/*
amtsblatt-gpt 🤖

Small bot that receives emails from the "Niedersächsische Verkündungsplattform"
and summarizes the legal changes with ChatGPT and evaluates their relevance for
the housing industry. The results are to be treated with care.
Any warranty is completely excluded!

*/

const primer = {
  "role": "system",
"content": 'Du bist ein deutschsprachiger Assistent, der neue Gesetze und Normen \
  zusammenfasst. Du erhälst Anfrafgen mit Volltexten der neuen Gesetze und sollst \
  sie in zwei Sätzen zusammenfassen. In einer neuen Zeile schreibst du einen kurzen \
  Satz, ob die Gesetzesänderung relevant für Wohnungsunternehmen oder die \
  Immobilienwirtschaft ist. Wenn das Gesetz relevant sein könnte, schreibe "Achtung! \
  Das Gesetz könnte relevant für die Wohnungswirtschaft sein." und begründe kurz, \
    warum du es für relevant hältst.'
};

const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');
const Imap = require('node-imap'), inspect = require('util').inspect;
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const openai = new OpenAI({
  apiKey: process.env['OPENAI_API_KEY']
});

const imapConfig = {
      user: process.env.EMAIL_USER,
  password: process.env.EMAIL_PASSWORD,
  host: "webspace29.do.de",
  port: 993,
  tls: true,
  authTimeout: 3000
};

let urlLimit = process.env.URL_LIMIT || -1;

console.log(`Starting Amtsblatt-GPT`)
console.log(` - EMAIL_USER: ${process.env.EMAIL_USER}`)
console.log(` - URL_LIMIT: ${process.env.URL_LIMIT}`)

const imap = new Imap(imapConfig);

// Function to open and set up IMAP connection
function openImapConnection() {
  imap.once('ready', function() {
    console.log('IMAP connected');
    openInbox();
  });

  imap.once('error', function(err) {
    console.error('IMAP Error:', err);
    reconnectImap();
  });

  imap.once('end', function() {
    console.log('IMAP connection ended');
    reconnectImap();
  });

  imap.connect();
}

// Function to open the inbox and set up event listeners
function openInbox() {
  imap.openBox('INBOX', false, function(err, box) {
    if (err) {
      console.error('Error opening inbox:', err);
      reconnectImap();
      return;
    }

    console.log(`BOX opened: ${box.messages.total} messages`);

    // Set up listener for new emails
    imap.on('mail', function(numNewMail) {
      console.log(`${numNewMail} new email(s) arrived`);
      fetchNewEmails();
    });

    // Initial fetch for any unseen emails
    fetchNewEmails();
  });
}

// Function to fetch and process new unseen emails
function fetchNewEmails() {
  imap.search(['UNSEEN'], function(err, results) {
    if (err) {
      console.error('Search error:', err);
      return;
    }

    if (!results || results.length === 0) {
      console.log('No new unseen emails found');
      return;
    }

    const fetch = imap.fetch(results, { bodies: '', markSeen: true });

    fetch.on('message', function(msg, seqno) {
      console.log('Processing Message #%d', seqno);
      let emailBuffer = '';

      msg.on('body', function(stream) {
        stream.on('data', function(chunk) {
          emailBuffer += chunk.toString('utf8');
        });
      });

      msg.on('end', function() {
        simpleParser(emailBuffer, async (err, parsed) => {
          if (err) {
            console.error('Error parsing email:', err);
            return;
          }

          const fromEmail = parsed.from.value[0].address;
          const originalHtml = parsed.html;
          const body = parsed.text || "";
          const links = body.match(/https:\/\/www\.verkuendung-niedersachsen\.de\/nds[^\s>]+/g) || [];
          const responses = [];

          console.log('Found links:', links);

          for (const link of links) {
            if (urlLimit > 0 && urlLimit-- === 0) break;
            const response = await processPDF(link).catch(error => console.error(`Error processing PDF from ${link}:`, error));
            if (response) {
              responses.push(response);
            }
          }

          await sendResponseEmail(fromEmail, responses, originalHtml);
        });
      });
    });

    fetch.once('error', function(err) {
      console.log('Fetch error:', err);
    });

    fetch.once('end', function() {
      console.log('Done fetching all new messages!');
    });
  });
}

// Function to reconnect IMAP after a delay
function reconnectImap() {
  console.log('Attempting to reconnect to IMAP in 5 seconds...');
  setTimeout(() => {
    imap.removeAllListeners();
    openImapConnection();
  }, 5000);
}

// Function to send response email
async function sendResponseEmail(to, responses, originalHtml) {
  let emailBody = '<p><strong>Hinweis:</strong> Die nachfolgende Auflistung wurde durch ChatGPT-4o erstellt. Die Zusammenfassung sowie die Einschätzung der Relevanz kann fehlerhaft sein und sollte immer einem manuellen Überprüfungsprozess unterzogen werden. Quellcode: <a href="https://github.com/MrApe/mbi-gpt">github.com</a></p>';
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
  try {
    let info = await transporter.sendMail({
      from: `"MBI Verkündigungs-Bot" <${process.env.EMAIL_USER}>`,
      to: to,
      subject: "Re: KI-Zusammenfassung aktueller Verkündigungen",
      html: emailBody,
    });

    console.log('Message sent:', info.messageId);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// Function to get summary from ChatGPT
async function getChatGPTSummary(text) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o", // Ensure this model name is correct
      messages: [
        primer,
        { "role": "user", "content": text }
      ]
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error getting response from ChatGPT:', error.message);
    return null;
  }
}

// Function to scrape PDF links and headline from a webpage
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
  });

  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle0' });

  const data = await page.evaluate(() => {
    const pdfLinks = Array.from(document.querySelectorAll('a'))
      .map(anchor => anchor.href)
      .filter(href => href.endsWith('.pdf'));

    const headlineElement = document.querySelector('h1');
    const headline = headlineElement ? headlineElement.innerText.trim() : 'Keine Überschrift gefunden';
    return { pdfLinks, headline };
  });

  await browser.close();
  return data;
}

// Function to process a single PDF link
async function processPDF(url) {
  try {
    const { pdfLinks, headline } = await scrapePDFLinksAndHeadline(url);

    if (pdfLinks.length === 0) {
      throw new Error('Keine PDF-Links auf der Seite gefunden.');
  }

    const pdfUrl = pdfLinks[0];
    console.log(`Lade PDF herunter von: ${pdfUrl}`);
    const pdfResponse = await axios({
      method: 'get',
      url: pdfUrl,
      responseType: 'arraybuffer'
    });

    const pdfPath = path.resolve(__dirname, 'downloaded.pdf');
    fs.writeFileSync(pdfPath, Buffer.from(pdfResponse.data, 'binary'));

    const dataBuffer = fs.readFileSync(pdfPath);
    const text = await pdfParse(dataBuffer);

    console.log(`Textextraktion abgeschlossen für ${url}. Überschrift: ${headline}`);
    let summary = await getChatGPTSummary(text.text);
    if (summary) {
      summary = summary.replace(/\n/g, '<br>');
      console.log(`ChatGPT Zusammenfassung:`, summary);
}

    cleanupSync();

    return { url, headline, summary };

  } catch (error) {
    console.error(`Fehler bei der Verarbeitung von ${url}:`, error.message);
  }
}

// Function to clean up downloaded PDF
function cleanupSync() {
  const filePath = path.resolve(__dirname, 'downloaded.pdf');

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log('downloaded.pdf erfolgreich entfernt.');
    }
  } catch (err) {
    console.error('Fehler beim Entfernen von downloaded.pdf:', err);
  }
}

// Initialize IMAP connection
openImapConnection();
