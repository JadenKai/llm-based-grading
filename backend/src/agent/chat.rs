//! The chat agent loop: stream a model turn, run its tool calls in order, repeat.

use super::{RunCtx, prompts, tools};
use crate::events::{Event, StepKind, StepStatus};
use crate::llm::{ChatMessage, ChatRequest, Role};

const HISTORY_LIMIT: usize = 40;

pub async fn run_chat(ctx: &RunCtx, user_text: String) -> anyhow::Result<()> {
    let settings = ctx.state.settings();
    let max_iters = settings.max_agent_iterations.max(1);

    // Fold the teacher's review decisions into this turn so the model sees them.
    let (system, mut history) = {
        let mut s = ctx.session.write().await;
        let log = std::mem::take(&mut s.review_log);
        let content =
            if log.is_empty() { user_text } else { format!("[Review updates]\n{}\n\n{user_text}", log.join("\n")) };
        s.history.push(ChatMessage::user(content));
        (prompts::chat_system(&s, settings.system_prompt.as_deref(), ctx.web.is_some()), trimmed(&s.history))
    };

    let mut tool_specs = ctx.tool_specs_enabled();
    let mut new_messages: Vec<ChatMessage> = Vec::new();
    let result: anyhow::Result<()> = async {
        for iter in 0..max_iters {
            let step = ctx.step_start(
                StepKind::Llm,
                if iter == 0 { "Thinking".to_string() } else { format!("Thinking (step {})", iter + 1) },
                None,
            );
            let message_id = format!("{}_m{iter}", ctx.run.id);
            let mut messages = vec![ChatMessage::system(system.clone())];
            messages.extend(history.iter().cloned());
            let req = ChatRequest {
                model: ctx.model.model.clone(),
                messages,
                tools: tool_specs.clone(),
                format: None,
                params: ctx.params.clone(),
            };
            let out = match ctx.stream_llm(req.clone(), &step, Some(&message_id)).await {
                Ok(o) => o,
                Err(e) if !tool_specs.is_empty() && e.to_string().contains("does not support tools") => {
                    ctx.emit(Event::Error {
                        message: format!(
                            "{} does not support tool calling; continuing without tools.",
                            ctx.model.model
                        ),
                        recoverable: true,
                    });
                    tool_specs.clear();
                    ctx.stream_llm(ChatRequest { tools: vec![], ..req }, &step, Some(&message_id)).await?
                }
                Err(e) => {
                    ctx.step_end(&step, StepStatus::Error, e.to_string());
                    return Err(e);
                }
            };

            let assistant = ChatMessage {
                role: Role::Assistant,
                content: out.text.clone(),
                thinking: (!out.thinking.is_empty()).then(|| out.thinking.clone()),
                tool_calls: out.tool_calls.clone(),
                tool_call_id: None,
                tool_name: None,
            };
            history.push(assistant.clone());
            new_messages.push(assistant);

            if out.tool_calls.is_empty() {
                ctx.step_end(&step, StepStatus::Ok, "");
                return Ok(());
            }
            ctx.step_end(&step, StepStatus::Ok, format!("{} tool call(s)", out.tool_calls.len()));

            for call in &out.tool_calls {
                ctx.check_cancel()?;
                let (kind, label) = tools::describe(call);
                let tstep = ctx.step_start(kind, label, None);
                ctx.emit(Event::ToolCall {
                    call_id: call.id.clone(),
                    step_id: tstep.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                });
                let outcome = tools::execute(ctx, call).await;
                ctx.emit(Event::ToolResult {
                    call_id: call.id.clone(),
                    ok: outcome.ok,
                    summary: outcome.summary.clone(),
                    data: outcome.data.clone(),
                });
                ctx.step_end(&tstep, if outcome.ok { StepStatus::Ok } else { StepStatus::Error }, outcome.summary);
                let msg = ChatMessage::tool(call, outcome.content);
                history.push(msg.clone());
                new_messages.push(msg);
            }
        }
        ctx.emit(Event::Error {
            message: format!("Stopped after {max_iters} agent steps (limit set in Settings)."),
            recoverable: true,
        });
        Ok(())
    }
    .await;

    // Keep whatever the model produced, even on failure, so the conversation stays coherent.
    ctx.session.write().await.history.extend(new_messages);
    result
}

/// The last `HISTORY_LIMIT` messages, starting at a user message so tool-call groups stay whole.
fn trimmed(history: &[ChatMessage]) -> Vec<ChatMessage> {
    if history.len() <= HISTORY_LIMIT {
        return history.to_vec();
    }
    let from = history.len() - HISTORY_LIMIT;
    let start = (from..history.len()).find(|&i| history[i].role == Role::User).unwrap_or(from);
    history[start..].to_vec()
}
