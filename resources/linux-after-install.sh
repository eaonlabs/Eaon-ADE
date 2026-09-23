#!/bin/bash
#
# electron-builder's own after-install template, with one correction.
#
# Upstream decides whether Chromium needs the setuid sandbox helper by trying
# `unshare --user true`. That probe runs inside the package's post-install
# script, which runs as **root** — and root can always create a user namespace,
# no matter what the kernel allows unprivileged users to do. So on a machine
# that has unprivileged user namespaces switched off the probe succeeds, the
# helper is left at 0755, and the app then fails to start for the person who
# installed it with:
#
#   The SUID sandbox helper binary was found, but is not configured correctly.
#
# Verified on Debian 12 with kernel.unprivileged_userns_clone=0: the upstream
# script leaves 0755 and the window never opens.
#
# So the sysctls are read directly instead, which says what an unprivileged
# process would actually be allowed to do. Ubuntu 24.04's AppArmor restriction
# is a separate mechanism and is still handled by the profile installed below.
#
# Everything else here is upstream's, kept in step with
# node_modules/app-builder-lib/templates/linux/after-install.tpl.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Can an *unprivileged* process create a user namespace on this kernel? Asking
# the sysctls rather than trying it, because this script is root.
UNPRIV_USERNS=1
if [ -r /proc/sys/kernel/unprivileged_userns_clone ] \
   && [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ]; then
    UNPRIV_USERNS=0
fi
if [ -r /proc/sys/user/max_user_namespaces ] \
   && [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = "0" ]; then
    UNPRIV_USERNS=0
fi
# No /proc/self/ns/user at all means the kernel has no user namespaces to speak of.
if [ ! -L /proc/self/ns/user ]; then
    UNPRIV_USERNS=0
fi

if [ "$UNPRIV_USERNS" = "0" ]; then
    # Fall back to the setuid sandbox helper. It is the older of the two
    # Chromium sandboxes but it is a sandbox, and the alternative on these
    # machines is an app that does not start.
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"

    # Updating the current AppArmor profile is not possible and probably not meaningful in a chroot'ed environment.
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi
