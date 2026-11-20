--[[ resume.lua - VLC 3.x Lua interface: remembers & restores position of every file.
     Data: <userdatadir>/resume_positions.txt   Log: <userdatadir>/resume.log ]]

local DIR        = vlc.config.userdatadir()
local DATA_FILE  = DIR .. "/resume_positions.txt"
local LOG_FILE   = DIR .. "/resume.log"
local MIN_SAVE   = 10
local END_MARGIN = 30
local TICK       = 1
local SAVE_EVERY = 3

local function log(msg)
  local f = io.open(LOG_FILE, "a")
  if f then f:write(os.date("%Y-%m-%d %H:%M:%S"), " ", msg, "\n"); f:close() end
  vlc.msg.info("[resume] " .. msg)
end

local positions, dirty = {}, false

local function load_positions()
  local n = 0
  local f = io.open(DATA_FILE, "r")
  if not f then return n end
  for line in f:lines() do
    local secs, uri = line:match("^(%d+)\t(.+)$")
    if secs and uri then positions[uri] = tonumber(secs); n = n + 1 end
  end
  f:close()
  return n
end

local function save_positions()
  local tmp = DATA_FILE .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then log("ERROR: cannot write " .. tmp); return end
  for uri, secs in pairs(positions) do f:write(secs, "\t", uri, "\n") end
  f:close()
  os.remove(DATA_FILE)
  os.rename(tmp, DATA_FILE)
  dirty = false
end

local function main()
  log("started; data file = " .. DATA_FILE)
  log("loaded " .. load_positions() .. " saved positions")

  local cur_uri, pending, restored, ticks = nil, nil, false, 0

  while true do
    if vlc.volume.get() == -256 then break end

    local input = vlc.object.input()
    local item  = input and vlc.input.item()

    if not input or not item then
      cur_uri, pending, restored = nil, nil, false
    else
      local uri = item:uri()
      if uri ~= cur_uri then
        cur_uri, pending, restored = uri, positions[uri], false
        log("now playing: " .. uri .. (pending and (" (saved pos " .. pending .. "s)") or " (no saved pos)"))
      end

      local status = vlc.playlist.status()
      local length = vlc.var.get(input, "length") or 0
      local t      = vlc.var.get(input, "time") or 0

      if not restored then
        if pending then
          if status == "playing" and length > 0 then
            if pending * 1000000 < length - END_MARGIN * 1000000 then
              vlc.var.set(input, "time", pending * 1000000)
              log("restored to " .. pending .. "s")
            end
            restored = true
          end
        else
          restored = true
        end
      elseif status == "playing" or status == "paused" then
        local secs = math.floor(t / 1000000)
        if length > 0 and t > length - END_MARGIN * 1000000 then
          if positions[uri] then positions[uri] = nil; dirty = true; log("finished, forgot position") end
        elseif secs >= MIN_SAVE and positions[uri] ~= secs then
          positions[uri] = secs; dirty = true
        end
      end
    end

    ticks = ticks + 1
    if dirty and ticks >= SAVE_EVERY then save_positions(); ticks = 0 end
    vlc.misc.mwait(vlc.misc.mdate() + TICK * 1000000)
  end

  if dirty then save_positions() end
  log("VLC exiting, final save done")
end

local ok, err = pcall(main)
if not ok then log("ERROR: " .. tostring(err)) end
