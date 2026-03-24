import cron from 'node-cron';
import Events from '../models/Events.js';
import Notification from '../models/Notification.js';
import Notice from '../models/Notice.js';
import User from '../models/User.js';
import Profile from '../models/Profile.js';

export const initScheduler = () => {
    // Schedule a task to run every day at 09:00 AM (server time)
    cron.schedule('0 9 * * *', async () => {
        console.log('Running daily housekeeping tasks...');
        await Promise.all([
            checkAndSendEventReminders(),
            checkAndSendEventParticipationConfirmations(),
            checkAndSendBirthdayReminders(),
            checkAndSendAnniversaryReminders(),
            checkAndSendDeathAnniversaryReminders(),
            deleteOldNotices(),
            checkSubscriptionExpiry()
        ]);
    });
};

const deleteOldNotices = async () => {
    try {
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

        console.log('Deleting notices older than:', oneYearAgo);

        // Deleting notices where endDate (if exists) is older than 1 year, 
        // OR where createdAt is older than 1 year (if no endDate).
        const result = await Notice.deleteMany({
            $or: [
                { endDate: { $lt: oneYearAgo } },
                { $and: [{ endDate: { $exists: false } }, { createdAt: { $lt: oneYearAgo } }] },
                { $and: [{ endDate: null }, { createdAt: { $lt: oneYearAgo } }] }
            ]
        });

        console.log(`Deleted ${result.deletedCount} old notices.`);
    } catch (error) {
        console.error("Error in deleteOldNotices:", error);
    }
};

const checkAndSendEventReminders = async () => {
    try {
        const today = new Date();
        const reminderDate = new Date(today);
        reminderDate.setDate(today.getDate() + 2); // Target: 2 days from now

        const targetDateString = reminderDate.toISOString().split('T')[0];

        const events = await Events.find({ startDate: targetDateString });

        for (const event of events) {
            if (!event.guests || event.guests.length === 0) continue;

            const guestsToNotify = event.guests.filter(g =>
                g.user && (g.status === 'accepted' || g.status === 'pending')
            );

            for (const guest of guestsToNotify) {
                // Create Notification for specific guest
                await Notification.create({
                    sender: event.createdBy,
                    recipient: guest.user, // Target specific user
                    treeId: event.treeId,
                    type: "event",
                    message: `Reminder: You have an event "${event.eventName}" in 2 days!`,
                    referenceId: event._id,
                });
            }
        }
    } catch (error) {
        console.error("Error in checkAndSendEventReminders:", error);
    }
};

const checkSubscriptionExpiry = async () => {
    try {
        console.log("Checking for subscription expiries...");
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Define target dates for 7 days and 1 day before expiry
        const sevenDaysFromNow = new Date(today);
        sevenDaysFromNow.setDate(today.getDate() + 7);

        const oneDayFromNow = new Date(today);
        oneDayFromNow.setDate(today.getDate() + 1);

        // Helper to match exact day
        const getDayRange = (date) => {
            const start = new Date(date);
            start.setHours(0, 0, 0, 0);
            const end = new Date(date);
            end.setHours(23, 59, 59, 999);
            return { $gte: start, $lte: end };
        };

        const expiringUsers = await User.find({
            $or: [
                { "subscription.expiryDate": getDayRange(sevenDaysFromNow) },
                { "subscription.expiryDate": getDayRange(oneDayFromNow) }
            ],
            "subscription.status": "active"
        });

        for (const user of expiringUsers) {
            // We need profile to get treeId
            // Importing Profile dynamically to avoid circular dependency issues if any
            const Profile = (await import('../models/Profile.js')).default;
            const userProfile = await Profile.findOne({ user: user._id });

            if (userProfile && userProfile.treeId) {
                const daysLeft = Math.ceil((new Date(user.subscription.expiryDate) - today) / (1000 * 60 * 60 * 24));

                await Notification.create({
                    sender: user._id, // Self-reminder
                    recipient: user._id,
                    treeId: userProfile.treeId,
                    type: "subscription",
                    message: `Your subscription will expire in ${daysLeft} days. Renew now to avoid interruption.`,
                    referenceId: user._id
                });
                console.log(`Sent expiry notification to ${user.firstname} (${daysLeft} days left)`);
            }
        }

    } catch (error) {
        console.error("Error in checkSubscriptionExpiry:", error);
    }
};

// Helper function to get family members for notifications
const getFamilyMembersForNotifications = async (treeId, excludeUserId) => {
    try {
        const profiles = await Profile.find({ treeId }).populate('user', 'firstname lastname');
        return profiles
            .filter(p => p.user && p.user._id.toString() !== excludeUserId.toString())
            .map(p => ({
                userId: p.user._id,
                name: `${p.user.firstname} ${p.user.lastname}`,
                profilePicture: p.profilePicture
            }));
    } catch (error) {
        console.error("Error getting family members:", error);
        return [];
    }
};

// Send birthday reminders (only within 3 days before birthday)
const checkAndSendBirthdayReminders = async () => {
    try {
        console.log("Checking birthday reminders...");
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Get dates for next 3 days (1, 2, and 3 days from now)
        const upcomingDates = [];
        for (let i = 1; i <= 3; i++) {
            const date = new Date(today);
            date.setDate(today.getDate() + i);
            upcomingDates.push({
                daysUntil: i,
                month: date.getMonth(),
                day: date.getDate(),
                year: date.getFullYear()
            });
        }
        
        // Find profiles with birthdays in the next 3 days
        const profiles = await Profile.find({
            dob: { $exists: true, $ne: null },
            dateOfDeath: { $exists: false } // Only for living members
        }).populate('user', 'firstname lastname');
        
        for (const profile of profiles) {
            if (!profile.dob || !profile.user) continue;
            
            const dob = new Date(profile.dob);
            const dobMonth = dob.getMonth();
            const dobDay = dob.getDate();
            
            // Check if birthday matches any of the upcoming 3 days
            const matchingDate = upcomingDates.find(d => d.month === dobMonth && d.day === dobDay);
            
            if (matchingDate) {
                const age = matchingDate.year - dob.getFullYear();
                const familyMembers = await getFamilyMembersForNotifications(profile.treeId, profile.user._id);
                
                // Notify family members
                for (const member of familyMembers) {
                    await Notification.create({
                        sender: profile.user._id,
                        recipient: member.userId,
                        treeId: profile.treeId,
                        type: "new_member",
                        message: matchingDate.daysUntil === 1 
                            ? `Tomorrow is ${profile.user.firstname}'s birthday! They will be turning ${age}.`
                            : `${profile.user.firstname}'s birthday is in ${matchingDate.daysUntil} days! They will be turning ${age}.`,
                        referenceId: profile.user._id
                    });
                }
                
                // Notify the birthday person themselves (only on day 1 - tomorrow)
                if (matchingDate.daysUntil === 1) {
                    await Notification.create({
                        sender: profile.user._id,
                        recipient: profile.user._id,
                        treeId: profile.treeId,
                        type: "new_member",
                        message: `Tomorrow is your birthday! You will be turning ${age}. Wishing you a wonderful year ahead!`,
                        referenceId: profile.user._id
                    });
                }
                
                console.log(`Birthday reminder sent for ${profile.user.firstname} (${matchingDate.daysUntil} days away)`);
            }
        }
    } catch (error) {
        console.error("Error in checkAndSendBirthdayReminders:", error);
    }
};

// Send marriage anniversary reminders (only within 3 days before anniversary)
const checkAndSendAnniversaryReminders = async () => {
    try {
        console.log("Checking marriage anniversary reminders...");
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Get dates for next 3 days (1, 2, and 3 days from now)
        const upcomingDates = [];
        for (let i = 1; i <= 3; i++) {
            const date = new Date(today);
            date.setDate(today.getDate() + i);
            upcomingDates.push({
                daysUntil: i,
                month: date.getMonth(),
                day: date.getDate(),
                year: date.getFullYear()
            });
        }
        
        // Find profiles with anniversaries in the next 3 days
        const profiles = await Profile.find({
            marriageDate: { $exists: true, $ne: null },
            dateOfDeath: { $exists: false } // Only for living members
        }).populate('user', 'firstname lastname');
        
        for (const profile of profiles) {
            if (!profile.marriageDate || !profile.user) continue;
            
            const marriageDate = new Date(profile.marriageDate);
            const annivMonth = marriageDate.getMonth();
            const annivDay = marriageDate.getDate();
            
            // Check if anniversary matches any of the upcoming 3 days
            const matchingDate = upcomingDates.find(d => d.month === annivMonth && d.day === annivDay);
            
            if (matchingDate) {
                const years = matchingDate.year - marriageDate.getFullYear();
                const familyMembers = await getFamilyMembersForNotifications(profile.treeId, profile.user._id);
                
                // Notify family members
                for (const member of familyMembers) {
                    await Notification.create({
                        sender: profile.user._id,
                        recipient: member.userId,
                        treeId: profile.treeId,
                        type: "new_member",
                        message: matchingDate.daysUntil === 1
                            ? `Tomorrow is ${profile.user.firstname}'s ${years}th marriage anniversary!`
                            : `${profile.user.firstname}'s ${years}th marriage anniversary is in ${matchingDate.daysUntil} days!`,
                        referenceId: profile.user._id
                    });
                }
                
                // Notify the couple (only on day 1 - tomorrow)
                if (matchingDate.daysUntil === 1) {
                    await Notification.create({
                        sender: profile.user._id,
                        recipient: profile.user._id,
                        treeId: profile.treeId,
                        type: "new_member",
                        message: `Tomorrow is your ${years}th marriage anniversary! Wishing you many more years of happiness!`,
                        referenceId: profile.user._id
                    });
                }
                
                console.log(`Anniversary reminder sent for ${profile.user.firstname} (${matchingDate.daysUntil} days away)`);
            }
        }
    } catch (error) {
        console.error("Error in checkAndSendAnniversaryReminders:", error);
    }
};

// Send death anniversary reminders (only within 3 days before anniversary)
const checkAndSendDeathAnniversaryReminders = async () => {
    try {
        console.log("Checking death anniversary reminders...");
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        // Get dates for next 3 days (1, 2, and 3 days from now)
        const upcomingDates = [];
        for (let i = 1; i <= 3; i++) {
            const date = new Date(today);
            date.setDate(today.getDate() + i);
            upcomingDates.push({
                daysUntil: i,
                month: date.getMonth(),
                day: date.getDate(),
                year: date.getFullYear()
            });
        }
        
        // Find profiles with death anniversaries in the next 3 days
        const profiles = await Profile.find({
            dateOfDeath: { $exists: true, $ne: null }
        }).populate('user', 'firstname lastname');
        
        for (const profile of profiles) {
            if (!profile.dateOfDeath || !profile.user) continue;
            
            const deathDate = new Date(profile.dateOfDeath);
            const deathAnnivMonth = deathDate.getMonth();
            const deathAnnivDay = deathDate.getDate();
            
            // Check if death anniversary matches any of the upcoming 3 days
            const matchingDate = upcomingDates.find(d => d.month === deathAnnivMonth && d.day === deathAnnivDay);
            
            if (matchingDate) {
                const years = matchingDate.year - deathDate.getFullYear();
                const familyMembers = await getFamilyMembersForNotifications(profile.treeId, profile.user._id);
                
                // Notify family members about death anniversary
                for (const member of familyMembers) {
                    await Notification.create({
                        sender: profile.user._id,
                        recipient: member.userId,
                        treeId: profile.treeId,
                        type: "new_member",
                        message: matchingDate.daysUntil === 1
                            ? `Tomorrow marks ${years} years since ${profile.user.firstname} passed away. Let us remember them with love.`
                            : `${matchingDate.daysUntil} days until ${profile.user.firstname}'s ${years}th death anniversary. Let us remember them with love.`,
                        referenceId: profile.user._id
                    });
                }
                
                console.log(`Death anniversary reminder sent for ${profile.user.firstname} (${matchingDate.daysUntil} days away)`);
            }
        }
    } catch (error) {
        console.error("Error in checkAndSendDeathAnniversaryReminders:", error);
    }
};

// Send event participation confirmation requests (3 days before event)
const checkAndSendEventParticipationConfirmations = async () => {
    try {
        console.log("Checking event participation confirmations...");
        const today = new Date();
        const confirmationDate = new Date(today);
        confirmationDate.setDate(today.getDate() + 3); // Target: 3 days from now
        
        const targetDateString = confirmationDate.toISOString().split('T')[0];
        
        const events = await Events.find({ startDate: targetDateString });
        
        for (const event of events) {
            if (!event.guests || event.guests.length === 0) continue;
            
            const guestsToConfirm = event.guests.filter(g =>
                g.user && g.status === 'pending'
            );
            
            for (const guest of guestsToConfirm) {
                // Create participation confirmation request notification
                await Notification.create({
                    sender: event.createdBy,
                    recipient: guest.user,
                    treeId: event.treeId,
                    type: "event",
                    message: `Please confirm your participation for "${event.eventName}" happening in 3 days. Tap to respond.`,
                    referenceId: event._id,
                });
            }
            
            if (guestsToConfirm.length > 0) {
                console.log(`Participation confirmation sent for event "${event.eventName}" to ${guestsToConfirm.length} guests`);
            }
        }
    } catch (error) {
        console.error("Error in checkAndSendEventParticipationConfirmations:", error);
    }
};
