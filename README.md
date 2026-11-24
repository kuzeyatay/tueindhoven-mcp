<img src="assets/tue-logo.svg" alt="Eindhoven University of Technology" width="250">

# TU Eindhoven MCP

Ask your AI assistant what is due in Canvas, where your next class meets or how your study plan fits together. Teachers can prepare assignments, review submissions and give feedback. This independent project connects your desktop AI app to the TU/e systems you already use.

**[Download the latest release](https://github.com/kuzeyatay/tueindhoven-mcp/releases/latest)**

## Install on Windows

You need a TU/e account, Microsoft Edge or Google Chrome, and one of these desktop apps: Codex, Claude Desktop, Cursor or VS Code. The Windows download includes Node.js.

1. On the release page, open **Assets** and download the file ending in **windows-x64.zip**. This build is for Intel and AMD Windows PCs.
2. Right-click the ZIP in Downloads and choose **Extract All**. Pick a folder you will keep, such as **Documents → TUe MCP**.
3. Open the extracted folder and double-click **Setup.cmd**. If Windows hides file extensions, the file is called **Setup**. Enter the number beside your AI app.
4. Press **Enter** to connect all four services, or choose just the ones you use. A browser opens for university sign-in. Complete any requested authentication there.
5. For **TE Timetable**, open **Personal schedule** in the TimeEdit tab. Copy its page address into the **Connect your TU/e timetable** tab. You can also use the iCalendar link under **Subscribe**.
6. Fully quit and reopen your AI app. Try **“Use tueindhoven to list my Canvas courses.”** If the app asks whether to enable the server or its tools, review the request and enable it.

To test the installation, quit the AI app and double-click **Check connections.cmd**. It prints a pass or failure for each service and returns counts. If you chose only Canvas, the other services may ask for a sign-in or feed. To reconnect, use **Sign in.cmd**.

## Install on macOS or Linux

Install **Node.js 22 or newer** and Google Chrome, Chromium or Microsoft Edge. Download the release file ending in **portable.zip** and extract it to a folder you plan to keep. On macOS, open **Setup.command** in that folder. Follow the numbered setup and sign-in prompts above. [Get Node.js LTS](https://nodejs.org/en/download)

On Linux, or if you prefer Terminal, run these commands inside the extracted folder:

```sh
node dist/cli.js install
node dist/verify.js
```

## What you can ask

| Service | Examples |
| --- | --- |
| Canvas coursework | “Show deadlines for this course.” “Read this week's module.” “Prepare my PDF for submission and show me its filename and assignment.” |
| Canvas quizzes | “Show the time limit before I start.” “Help me work through the questions in my active Classic Quiz.” “Save these answers, then show me the final submission step.” |
| Canvas teaching | “Create a draft assignment worth 10 points.” “List submissions waiting for feedback.” “Prepare a rubric assessment using the scores I give you.” |
| Canvas coordination | “Find course groups.” “Show my calendar.” “Draft an announcement.” Account staff can discover enrollment, reporting and account tools using the same catalog. |
| TE Timetable | “Where is my first class tomorrow?” “Show lectures and exams for the next two weeks.” |
| OSIRIS Student | “Show my official results.” “Summarize my programme progress.” “Open the registration form and preview registering for this course.” |
| OSIRIS PlanApp | “List the courses in each year of my current plan.” “Open my plan and help me edit this elective.” |

Canvas enforces your permissions per course. The searchable catalog includes **187 operations** in the bundled version. Your assistant can use `canvas_search_tools` and `canvas_describe_tool` to find an operation and inspect its inputs. OSIRIS Student and PlanApp return the records rendered in their current views. Their registration and planning tools use the forms available to your account. Each change previews the named control and any value to enter. TE Timetable reads the dates covered by your subscription.

### Turning in work

For a file assignment, put the file in **Downloads** and give the assistant its exact name and the Canvas assignment. The MCP previews the filename, size, destination IDs and SHA-256 fingerprint. Approving the upload returns a Canvas file ID. Approving **submit_assignment** turns in the uploaded file. Text-entry and website assignments go straight to the submission preview. You can check the resulting submission in Canvas. The local file helper supports files up to 20 MiB.

Classic Quizzes support starting an attempt, reading the learner questions, saving answers and completing the attempt. Starting can consume an attempt and start a timer. The assistant uses the question text and choices to help reason through answers. The quiz tools present separate previews for each change. New Quizzes also has instructor catalog tools and a learner form reader for accessible controls in embedded Instructure assessments. For external assessments, proctoring, access codes and widgets that require direct interaction, continue in Canvas. Follow the assessment rules set by your course.

### Your data

The MCP runs locally. The browser stores university sign-ins in its own profile under `~/.tueindhoven-mcp`. The personal calendar address is saved in the same directory. Treat that directory as private. Your AI app receives the records returned by the tools you use and processes them according to that app's settings. To disconnect, remove the `tueindhoven` entry from the AI app. With the app closed, you can also remove this project's profile directory to erase its saved sessions and feed.

## Troubleshooting

| If you see… | What to do |
| --- | --- |
| The assistant cannot find the tools | Restart the entire AI app. If you moved the extracted folder, rerun Setup so the app has the new path. |
| A browser-in-use error | Quit other AI clients and close the project's browser window. Run sign-in or the connection check again. One process can use the dedicated browser profile at a time. |
| An expired sign-in | Quit the AI client, open **Sign in**, and select the affected service. |
| A Canvas permission error | Check whether the same account can perform that action in that course on the Canvas website. |
| A missing timetable feed | Open **Sign in**, choose **4**, then paste your personal schedule page or its subscription address into the local form. |
| A submission times out | Open the assignment or quiz in Canvas and check its receipt or attempt status before trying again. |

## Development and other MCP clients

```sh
git clone https://github.com/kuzeyatay/tueindhoven-mcp.git
cd tueindhoven-mcp
npm ci
npm test
node dist/cli.js install
npm run verify
```

Other local stdio clients can launch `node` with the absolute path to `dist/cli.js` and the argument `serve`. Use the bundled `node.exe` for the Windows package. To preview a client configuration change, run `node dist/cli.js setup codex --dry-run`.

Optional settings include `TUE_BROWSER_PATH` for a browser executable, `TUE_UPLOAD_DIR` for the local upload folder and `TUE_CANVAS_TOKEN` for a Canvas personal API token. `TUE_TIMETABLE_ICS` supplies a personal subscription address. `TUE_TIMETABLE_URL` supplies a personal schedule page to `node dist/cli.js login timetable`. Keep personal values out of git and chat.

## Verification

The live check launches a separate MCP server over stdio. It checks the signed-in Canvas profile, courses, assignments when available, the embedded catalog, OSIRIS results and study progress, the PlanApp study-year view and the personal TE Timetable feed. These checks passed with a TU/e student account. Automated fixtures exercise assignment submissions, Classic Quiz attempts, instructor actions, permission denials and calendar recurrence. Live coursework submissions and instructor grading require a suitable test course.

## Credits and license

The Delft project provided the calendar expansion, confirmation store and configuration merge code. The Canvas catalog comes from Christian Bru's Canvas LMS MCP. The learner quiz implementation follows Instructure's Canvas API. [tudelft-mcp](https://github.com/danieltyukov/tudelft-mcp) · [canvas-lms-mcp](https://github.com/bruchris/canvas-lms-mcp) · [Canvas developer documentation](https://developerdocs.instructure.com/services/canvas) · [MIT license](LICENSE)

The TU/e wordmark identifies the university. Eindhoven University of Technology owns its branding. This project is independently maintained. [Wordmark source and attribution](https://commons.wikimedia.org/wiki/File:Eindhoven_University_of_Technology_logo_new.svg)
